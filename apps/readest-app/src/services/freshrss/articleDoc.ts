import type { FreshRSSArticle } from '@/types/freshrss';
import type { AppService, FileSystem } from '@/types/system';
import { htmlToBook } from '@/services/send/conversion/convertToEpub';
import { bundleAssets } from '@/services/send/conversion/assetBundler';
import { generateCoverSvg } from '@/services/send/conversion/coverGenerator';
import { extractArticle, resolveArticleHtml } from '@/services/rss/feedArticleContent';
import { guardedFetchText } from '@/services/rss/feedGuardedFetch';

/**
 * Blank block appended after every article so the floating Done / Obsidian
 * buttons never sit over the text. Styled by `.rss-tail` in buildEpub.
 *
 * Must be a `<p>` carrying a non-breaking space: the sanitizer strips `<div>`
 * entirely, and an element with no content can be dropped as empty.
 */
export const ARTICLE_TAIL = '<p class="rss-tail"> </p>';

/** How long the decorative favicon may hold up opening an article. */
const FAVICON_TIMEOUT_MS = 4000;
/** Overall budget for fetching+embedding the article's images. */
const ASSETS_TIMEOUT_MS = 10_000;

/** Fetch the source feed's favicon (via the same-origin image proxy) for the
 *  cover avatar. Returns undefined on any failure — the cover generator then
 *  falls back to an initial-letter avatar.
 *
 *  MUST stay bounded: this runs on the article-open path, and an unbounded
 *  await here wedged the entire feed list until reload. The proxy bounds its
 *  own UPSTREAM fetch, which does nothing when the browser→proxy request is
 *  what stalls. */
async function fetchFavicon(
  iconUrl?: string,
): Promise<{ bytes: ArrayBuffer; mime: string } | undefined> {
  if (!iconUrl) return undefined;
  try {
    const res = await fetch(`/api/img?url=${encodeURIComponent(iconUrl)}`, {
      signal: AbortSignal.timeout(FAVICON_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    const mime = (res.headers.get('content-type') || '').split(';')[0] || '';
    if (!mime.startsWith('image/')) return undefined;
    const bytes = await res.arrayBuffer();
    return bytes.byteLength ? { bytes, mime } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve to `fallback` if `work` hasn't settled within `ms`. The underlying
 * promise is abandoned, not cancelled — callers use this for work that is
 * merely *nice to have* before the reader opens.
 */
export const withDeadline = async <T>(work: Promise<T>, ms: number, fallback: T): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } catch {
    // A failed bundle shouldn't sink the whole article either.
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/** How long recovering a teaser-only article's full text may hold up opening it. */
const FULL_TEXT_TIMEOUT_MS = 8000;
/** Recovered bodies kept for the session, so the open and the summary share one fetch. */
const FULL_TEXT_CACHE_MAX = 50;
const fullTextCache = new Map<string, Promise<string>>();

export const clearFullTextCache = () => fullTextCache.clear();

/** Extract the article from its page with upstream's Readability pass, minus the
 *  `<h1>` it prepends — the masthead already carries the headline. */
const fetchFullText = async (url: string): Promise<string> => {
  const doc = new DOMParser().parseFromString(
    extractArticle(await guardedFetchText(url), url),
    'text/html',
  );
  doc.body.querySelector(':scope > h1')?.remove();
  return doc.body.innerHTML;
};

/**
 * The article body to read and summarize. Summary-only feeds give FreshRSS a
 * teaser as the content; when upstream's RSS reader would consider that too
 * thin (`resolveArticleHtml`, i.e. under MIN_FEED_CONTENT), fetch the page
 * through upstream's guarded fetch and extract the article. Any failure — or a
 * page slower than {@link FULL_TEXT_TIMEOUT_MS} — keeps the feed's own content,
 * and only successes are cached, so the next open retries.
 */
export const resolveArticleBody = (article: FreshRSSArticle): Promise<string> => {
  const own = article.contentHtml || '';
  const item = { id: article.id, title: article.title, link: article.url, read: false };
  if (!article.url || 'html' in resolveArticleHtml({ ...item, contentHtml: own })) {
    return Promise.resolve(own);
  }
  const cached = fullTextCache.get(article.id);
  if (cached) return cached;
  const pending = withDeadline(
    fetchFullText(article.url).catch(() => null),
    FULL_TEXT_TIMEOUT_MS,
    null,
  ).then((full) => {
    if (full?.trim()) return full;
    fullTextCache.delete(article.id);
    return own;
  });
  if (fullTextCache.size >= FULL_TEXT_CACHE_MAX) {
    fullTextCache.delete(fullTextCache.keys().next().value!);
  }
  fullTextCache.set(article.id, pending);
  return pending;
};

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Strip a feed-injected "reading time" widget from the top of the content —
 * e.g. ynet's "⏱ 2 דקות קריאה (במהירות: 1)" line. Matched only by a stopwatch
 * emoji at the start of a block (or a bare stopwatch run followed by
 * minutes/reading words), so real prose is never touched. We render our own
 * neutral read-time in the byline instead.
 */
const stripReadingTimeWidget = (html: string): string =>
  html
    .replace(/<(p|div)\b[^>]*>\s*(?:<[^>]+>\s*)*[⏱⏲][\s\S]*?<\/\1>/giu, '')
    .replace(/[⏱⏲][^<\n]*?(?:דקות|דק['׳]|minutes?|min read)[^<\n]*/giu, '');

// Rough adult reading pace; good enough for a "N min read" estimate.
const WORDS_PER_MINUTE = 200;

/** Estimated reading time in whole minutes (min 1) from an HTML body. */
const estimateReadMinutes = (html: string): number => {
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = text ? text.split(' ').length : 0;
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
};

const HEBREW_CHAR = /[֐-׿]/;

/**
 * The visible article header rendered at the top of the content: source favicon
 * + source name, the headline (`<h1>`, also the TOC anchor), and a byline
 * (author · date). The cover image only shows in the library thumbnail, never in
 * the reading view, so the header has to live in the content itself. The favicon
 * `<img>` is bundled like any other article image (fetched via /api/img). Uses
 * only sanitize-allowed tags; `<body dir="auto">` handles RTL alignment.
 */
function buildMasthead(article: FreshRSSArticle, readMinutes: number): string {
  const date = article.publishedAt ? new Date(article.publishedAt).toLocaleDateString() : '';
  // `rss-source` centres the row and vertically-middles the name against the
  // logo; `rss-logo` shrinks the favicon (see buildEpub CSS).
  const logo = article.feedIconUrl
    ? `<img class="rss-logo" src="${escapeHtml(article.feedIconUrl)}" alt="" />`
    : '';
  const source = article.feedTitle ? `<strong>${escapeHtml(article.feedTitle)}</strong>` : '';
  // The source row (logo + name) links to the original article when we have
  // its URL — a natural, large tap target above the headline, so no separate
  // byline link is needed. Anchor/href are on the sanitizer allow-list.
  const sourceInner = `${logo}${source}`;
  const sourceContent =
    (logo || source) && article.url
      ? `<a href="${escapeHtml(article.url)}">${sourceInner}</a>`
      : sourceInner;
  const sourceLine = logo || source ? `<p class="rss-source">${sourceContent}</p>` : '';
  const titleLine = `<h1>${escapeHtml(article.title || '(untitled)')}</h1>`;
  // Estimated read time joins the byline. Hebrew feeds get a Hebrew label; the
  // masthead is a plain string with no i18n context, so this is a light
  // script sniff rather than a full translation.
  const isHebrew =
    HEBREW_CHAR.test(article.title || '') || HEBREW_CHAR.test(article.feedTitle || '');
  const readLabel =
    readMinutes > 0 ? (isHebrew ? `${readMinutes} דקות קריאה` : `${readMinutes} min read`) : '';
  const byline = [article.author, date, readLabel]
    .filter(Boolean)
    .map((s) => escapeHtml(s as string))
    .join(' · ');
  const bylineLine = byline ? `<p class="rss-byline">${byline}</p>` : '';
  return `${sourceLine}${titleLine}${bylineLine}<hr />`;
}

/**
 * Turn a FreshRSS article into an EPUB `File`. Prepends a masthead (source logo +
 * name + headline + byline), then reuses the Send-to-Readest clipper pipeline:
 * fetch + embed every image (incl. the favicon) via the same-origin image proxy,
 * then `htmlToBook` (sanitize → valid XHTML → `buildEpub`) with language/RTL
 * detection.
 *
 * Also attaches a synthetic cover (favicon + name + title) — used for the library
 * thumbnail, and an explicit cover stops foliate-js falling back to the first
 * CONTENT image as the cover (epub.js `Resources.cover`), which duplicated the
 * lead photo.
 */
export async function articleToFile(article: FreshRSSArticle): Promise<File> {
  const rawBody = stripReadingTimeWidget(
    (await resolveArticleBody(article)).trim() || `<p>${escapeHtml(article.title || '')}</p>`,
  );
  const readMinutes = estimateReadMinutes(rawBody);
  // The trailing spacer is what actually keeps the floating Done/Obsidian
  // buttons off the closing lines — see the .rss-tail rule in buildEpub. The
  // buttons are fixed overlays outside the viewer iframe, so the clearance has
  // to be part of the DOCUMENT; asking foliate for a bottom margin does
  // nothing in scrolled horizontal mode. `<p>` (not `<div>`) because the
  // sanitizer drops divs.
  const body = buildMasthead(article, readMinutes) + rawBody + ARTICLE_TAIL;
  // useProxy routes the cross-origin image fetches through /api/img on web; on
  // Tauri the bundler hits the network directly (no CORS), ignoring the flag.
  //
  // The bundler bounds each image (8s) but not the SET of them: its 4-worker
  // pool over a 20-image article whose origin is slow costs ~40s of dead wait
  // before the reader appears. Cap the whole phase and fall back to the
  // unbundled body — images then resolve to their alt text, which is a far
  // better outcome than a minute of nothing.
  const author = article.author || article.feedTitle || '';
  const [bundle, favicon] = await Promise.all([
    withDeadline(bundleAssets(body, article.url || '', { useProxy: true }), ASSETS_TIMEOUT_MS, {
      html: body,
      images: [],
      missing: 0,
    }),
    // Decorative only, and independent of the image phase — run it alongside
    // rather than after, so it can never add to the open latency.
    fetchFavicon(article.feedIconUrl),
  ]);
  const cover = generateCoverSvg({
    title: article.title || '(untitled)',
    siteName: article.feedTitle || '',
    author,
    favicon,
  });
  const { file } = await htmlToBook(
    bundle.html,
    article.title || '(untitled)',
    author,
    article.url || article.id,
    bundle.images,
    cover,
  );
  return file;
}

/**
 * Build the article EPUB and stage it in the OPFS `Cache`, returning an absolute
 * path usable for a transient import.
 *
 * Why a path and not the File: `bookService.importBook` rejects a transient
 * `File` ("Transient import is only supported for file paths"), and on web there
 * are no native paths — content lives in OPFS. Staging in `Cache` (not `Books/`)
 * mirrors the cover-cache pattern and means the article is never persisted to
 * the library or WebDAV-synced. The path is `<cachePrefix>/<key>`, resolvable
 * with base `'None'` (how `importBook`/`bookContent` read it).
 */
export async function articleToCachePath(
  article: FreshRSSArticle,
  appService: AppService,
): Promise<string> {
  // getPrefix lives on FileSystem, which AppService keeps `protected`; reach it
  // via a narrow cast (the concrete app-service instance always has `fs`).
  const fs = (appService as AppService & { fs: FileSystem }).fs;
  const file = await articleToFile(article);
  const key = `feed-${(article.id || 'article').replace(/[^a-zA-Z0-9]/g, '_').slice(-48)}.epub`;
  const prefix = await fs.getPrefix('Cache');
  await fs.writeFile(key, 'Cache', file);
  return `${prefix}/${key}`;
}
