import type { FreshRSSFolder, FreshRSSFeed, FreshRSSArticle, FreshRSSPage } from '@/types/freshrss';
import { decodeEntities } from './text';

const READ_TAG = 'user/-/state/com.google/read';
const labelOf = (streamId: string) => streamId.split('/').pop() ?? streamId;

export function parseTagList(json: { tags?: { id: string }[] }): FreshRSSFolder[] {
  return (json.tags ?? [])
    .filter((t) => t.id.includes('/label/'))
    .map((t) => ({ id: t.id, label: labelOf(t.id), unreadCount: 0 }));
}

export function parseSubscriptions(json: {
  subscriptions?: { id: string; title: string; iconUrl?: string; categories?: { id: string }[] }[];
}): FreshRSSFeed[] {
  return (json.subscriptions ?? []).map((s) => ({
    id: s.id,
    title: decodeEntities(s.title),
    folderId: s.categories?.[0]?.id ?? null,
    unreadCount: 0,
    iconUrl: s.iconUrl || undefined,
  }));
}

export function parseUnreadCounts(json: {
  unreadcounts?: { id: string; count: number }[];
}): Map<string, number> {
  const m = new Map<string, number>();
  for (const u of json.unreadcounts ?? []) m.set(u.id, u.count);
  return m;
}

export function mergeUnreadCounts(
  feeds: FreshRSSFeed[],
  folders: FreshRSSFolder[],
  counts: Map<string, number>,
): { feeds: FreshRSSFeed[]; folders: FreshRSSFolder[] } {
  return {
    feeds: feeds.map((f) => ({ ...f, unreadCount: counts.get(f.id) ?? 0 })),
    folders: folders.map((f) => ({ ...f, unreadCount: counts.get(f.id) ?? 0 })),
  };
}

type RawItem = {
  id: string;
  categories?: string[];
  title?: string;
  author?: string;
  published?: number;
  canonical?: { href: string }[];
  alternate?: { href: string }[];
  origin?: { streamId?: string; title?: string };
  content?: { content?: string };
  summary?: { content?: string };
};

export function parseStreamContents(json: {
  continuation?: string;
  items?: RawItem[];
}): FreshRSSPage {
  const articles: FreshRSSArticle[] = (json.items ?? []).map((it) => ({
    id: it.id,
    feedId: it.origin?.streamId ?? '',
    // The GReader API returns plain-text fields HTML-escaped (`&quot;`); decode
    // them once here so every consumer (list, masthead, Obsidian export) gets
    // text. contentHtml/summaryHtml stay HTML.
    feedTitle: decodeEntities(it.origin?.title ?? ''),
    categories: (it.categories ?? [])
      .filter((c) => c.includes('/label/'))
      .map((c) => c.slice(c.indexOf('/label/') + '/label/'.length)),
    title: decodeEntities(it.title ?? '(untitled)'),
    author: decodeEntities(it.author ?? '') || undefined,
    url: it.canonical?.[0]?.href ?? it.alternate?.[0]?.href ?? '',
    publishedAt: (it.published ?? 0) * 1000,
    contentHtml: it.content?.content ?? it.summary?.content ?? '',
    summaryHtml: it.summary?.content,
  }));
  return { articles, continuation: json.continuation };
}

export function buildMarkReadBody(itemId: string, writeToken: string): string {
  const p = new URLSearchParams();
  p.set('i', itemId);
  p.set('a', READ_TAG);
  p.set('T', writeToken);
  return p.toString();
}

/** Body for removing the read tag again (the dismiss-undo window). */
export function buildMarkUnreadBody(itemId: string, writeToken: string): string {
  const p = new URLSearchParams();
  p.set('i', itemId);
  p.set('r', READ_TAG); // `r` removes, `a` adds
  p.set('T', writeToken);
  return p.toString();
}

/**
 * Body for GReader's mark-all-as-read. `ts` bounds the operation to items older
 * than that microsecond timestamp, so articles that arrive DURING the request
 * are not silently marked read — pass the newest timestamp the client has seen.
 */
export function buildMarkAllReadBody(
  streamId: string,
  writeToken: string,
  beforeMs?: number,
): string {
  const p = new URLSearchParams();
  p.set('s', streamId);
  p.set('T', writeToken);
  if (beforeMs && Number.isFinite(beforeMs)) {
    p.set('ts', String(Math.floor(beforeMs) * 1000)); // GReader wants microseconds
  }
  return p.toString();
}

// --- proxy-backed client -------------------------------------------------
// All connection details (server URL + credentials) live server-side in the
// /api/freshrss route's env vars. This client only ever sends RELATIVE GReader
// paths, so nothing sensitive is held in the browser or the JS bundle and the
// connection survives any browser-storage eviction.

/** Ceiling on one proxied round-trip. The server bounds its own upstream call
 *  at 20s; without a client-side bound a wedged request hangs the UI action
 *  that awaits it (refresh blanking the list, Done never returning). */
const REQUEST_TIMEOUT_MS = 15_000;

async function proxy(opts: {
  path: string;
  method?: 'GET' | 'POST';
  auth?: string;
  body?: string;
}): Promise<string> {
  const res = await fetch('/api/freshrss', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`freshrss proxy ${res.status}`);
  return res.text();
}

/**
 * Session credentials, shared by every client instance.
 *
 * Each call site constructs `new FreshRSSClient()`, so per-instance auth meant
 * re-logging in for EVERY action: mark-read was 3 sequential round-trips
 * (ClientLogin + token + the edit) instead of 1, and opening a stream was 3
 * instead of 1. The token is not user-specific here (credentials live
 * server-side and never reach the browser), so caching it at module scope is
 * safe and cuts the latency of every feed action by ~⅔.
 */
let sessionAuth: { auth: string; writeToken: string } | undefined;
/** Test-only reset. */
export const resetFreshRSSSession = () => {
  sessionAuth = undefined;
};

export class FreshRSSClient {
  private get auth() {
    return sessionAuth?.auth;
  }
  private get writeToken() {
    return sessionAuth?.writeToken;
  }

  async login(): Promise<void> {
    // Credentials are injected server-side on this request.
    const text = await proxy({ path: '/accounts/ClientLogin', method: 'POST' });
    const m = text.match(/Auth=(.+)/);
    if (!m) {
      throw new Error(
        'FreshRSS login failed: check the server configuration (FRESHRSS_URL / FRESHRSS_USERNAME / FRESHRSS_API_PASSWORD)',
      );
    }
    const auth = m[1]!.trim();
    const writeToken = (await proxy({ path: '/reader/api/0/token', auth })).trim();
    sessionAuth = { auth, writeToken };
  }

  /**
   * Run a request with the cached session, re-logging in once if the server
   * rejects it — a cached token outlives its server-side session eventually,
   * and that must self-heal rather than surface as a failed action.
   */
  private async withSession<T>(run: () => Promise<T>): Promise<T> {
    if (!sessionAuth) await this.login();
    try {
      return await run();
    } catch (e) {
      if (!/\b40[13]\b/.test(String(e))) throw e;
      sessionAuth = undefined;
      await this.login();
      return run();
    }
  }

  private async getJson<T>(path: string): Promise<T> {
    return this.withSession(async () => {
      const text = await proxy({ path, auth: this.auth });
      return JSON.parse(text) as T;
    });
  }

  async listFoldersAndFeeds(): Promise<{ folders: FreshRSSFolder[]; feeds: FreshRSSFeed[] }> {
    // Independent reads — issue them together instead of in series, so the
    // folder view costs one round-trip's latency rather than three.
    const [tags, subs, unread] = await Promise.all([
      this.getJson<Parameters<typeof parseTagList>[0]>('/reader/api/0/tag/list?output=json'),
      this.getJson<Parameters<typeof parseSubscriptions>[0]>(
        '/reader/api/0/subscription/list?output=json',
      ),
      this.getJson<Parameters<typeof parseUnreadCounts>[0]>(
        '/reader/api/0/unread-count?output=json',
      ),
    ]);
    return mergeUnreadCounts(
      parseSubscriptions(subs),
      parseTagList(tags),
      parseUnreadCounts(unread),
    );
  }

  async getUnread(streamId: string, count = 40, continuation?: string): Promise<FreshRSSPage> {
    const p = new URLSearchParams({ output: 'json', xt: READ_TAG, n: String(count) });
    if (continuation) p.set('c', continuation);
    const path = `/reader/api/0/stream/contents/${encodeURIComponent(streamId)}?${p.toString()}`;
    return parseStreamContents(await this.getJson<Parameters<typeof parseStreamContents>[0]>(path));
  }

  async markRead(itemId: string): Promise<void> {
    await this.withSession(() =>
      proxy({
        path: '/reader/api/0/edit-tag',
        method: 'POST',
        auth: this.auth,
        body: buildMarkReadBody(itemId, this.writeToken!),
      }),
    );
  }

  /** Undo a mark-read (removes the read tag), for the dismiss-undo window. */
  async markUnread(itemId: string): Promise<void> {
    await this.withSession(() =>
      proxy({
        path: '/reader/api/0/edit-tag',
        method: 'POST',
        auth: this.auth,
        body: buildMarkUnreadBody(itemId, this.writeToken!),
      }),
    );
  }

  /** Mark a whole stream (feed or folder) read, bounded to items we've seen. */
  async markAllRead(streamId: string, beforeMs?: number): Promise<void> {
    await this.withSession(() =>
      proxy({
        path: '/reader/api/0/mark-all-as-read',
        method: 'POST',
        auth: this.auth,
        body: buildMarkAllReadBody(streamId, this.writeToken!, beforeMs),
      }),
    );
  }
}
