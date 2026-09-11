'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, TouchEvent } from 'react';
import clsx from 'clsx';
import {
  MdClose,
  MdExpandLess,
  MdMenuBook,
  MdDeleteOutline,
  MdAutoAwesome,
  MdSearch,
} from 'react-icons/md';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { useFeedsStore } from '@/store/feedsStore';
import { useOpenFeedArticle } from '../useOpenFeedArticle';
import { useFeedShortcuts } from '../useFeedShortcuts';
import type { CachedSummary, SummaryFormat } from '@/services/freshrss/summaryCache';
import { FreshRSSClient } from '@/services/freshrss/greaderClient';
import { eventDispatcher } from '@/utils/event';
import type { FreshRSSArticle } from '@/types/freshrss';

// Named HTML entities that actually appear in feed text. The numeric branch of
// `decodeEntities` covers every other codepoint, so this only needs the common
// named ones (an unknown name passes through unchanged rather than breaking).
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  euro: '€',
  pound: '£',
  times: '×',
};

/** Decode HTML character entities (`&quot;` → `"`, `&#39;` → `'`, `&#xE9;` → `é`)
 *  without a DOM/parser — pure string transform, cheap enough for the whole list. */
const decodeEntities = (s: string): string =>
  s.includes('&')
    ? s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
        if (e[0] === '#') {
          const code =
            e[1]!.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
          return Number.isFinite(code) ? String.fromCodePoint(code) : m;
        }
        return ENTITIES[e.toLowerCase()] ?? m;
      })
    : s;

// Strip real tags FIRST, then decode entities — so an encoded `&lt;b&gt;` becomes
// visible text `<b>` rather than being mistaken for a tag (React escapes it on render).
const stripText = (html: string): string =>
  decodeEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

// Hebrew/Arabic and other RTL blocks. `dir='auto'` only inspects the FIRST
// strong character, so a Hebrew article whose title/blurb opens with a Latin
// brand name, acronym, or quoted English ("BBC: …") is wrongly laid out LTR.
// Decide by the MAJORITY of strong characters instead — robust for mixed
// Hebrew/English news strings.
const RTL_CHAR = /[֐-׿؀-ۿ܀-ݏݐ-ݿࢠ-ࣿיִ-﷿ﹰ-﻿]/;
const LTR_CHAR = /[A-Za-zÀ-ɏ]/;
const textDir = (s: string): 'rtl' | 'ltr' => {
  let rtl = 0;
  let ltr = 0;
  for (const ch of s) {
    if (RTL_CHAR.test(ch)) rtl++;
    else if (LTR_CHAR.test(ch)) ltr++;
  }
  return rtl > ltr ? 'rtl' : 'ltr';
};

const firstParagraph = (html: string) => {
  const m = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  return stripText(m ? m[1]! : html);
};

const wordCount = (a: FreshRSSArticle) => {
  const t = stripText(a.contentHtml);
  return t ? t.split(/\s+/).length : 0;
};

const QUICK_VIEW_MAX = 700;

/** Whether the feed gives this article a genuine blurb (a summary that's a real
 *  excerpt, shorter than the full content) vs. only full text. Blurb-less
 *  articles are the ones we auto-summarize with an LLM. */
const hasBlurb = (a: FreshRSSArticle) => {
  if (!a.summaryHtml) return false;
  const summary = stripText(a.summaryHtml);
  return !!summary && summary.length < stripText(a.contentHtml).length;
};

/**
 * The quick-view blurb: the feed's summary/description when it's a genuine
 * excerpt (present and shorter than the full content), otherwise the first
 * paragraph of the content. Capped so the expanded card can't balloon. An LLM
 * summary (when available) takes precedence over this — see the component.
 */
const quickViewText = (a: FreshRSSArticle) => {
  const content = stripText(a.contentHtml);
  let text = '';
  if (hasBlurb(a)) text = stripText(a.summaryHtml!);
  if (!text) text = firstParagraph(a.contentHtml) || content;
  return text.length > QUICK_VIEW_MAX ? `${text.slice(0, QUICK_VIEW_MAX).trim()}…` : text;
};

/** One formatter for the whole list. `toLocaleDateString()` per row per render
 *  re-resolves the locale every time and showed up as real work on long queues. */
const DATE_FMT = new Intl.DateTimeFormat();
const TIME_FMT = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

/**
 * Feed reading is recency-driven, and a bare '8/5/2026' says nothing useful
 * about an article posted an hour ago. Recent items get an age, today's get a
 * clock time, older ones keep the date.
 */
const formatWhen = (ms: number, now: number): string => {
  const mins = Math.floor((now - ms) / 60_000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 12) return `${hours}h`;
  const d = new Date(ms);
  if (hours < 48 && d.toDateString() === new Date(now).toDateString()) return TIME_FMT.format(d);
  return DATE_FMT.format(d);
};

/**
 * Everything a row needs that has to be DERIVED from the article. All of it is
 * regex/DOM-ish string work over the full `contentHtml`, and it used to run per
 * row on every render — and three times per article on every search keystroke.
 * Computed once per queue change instead, and the search matches a prebuilt
 * lowercase blob rather than re-stripping HTML per keypress.
 */
interface ArticleView {
  dir: 'rtl' | 'ltr';
  words: number;
  dateStr: string | null;
  feedTitle: string | null;
  categories: string | null;
  quickView: string;
  search: string;
}

const deriveView = (a: FreshRSSArticle, now: number): ArticleView => {
  const quickView = quickViewText(a);
  return {
    // One direction per article (from the title) so the title, byline, blurb
    // and AI summary all align consistently — see textDir for why not auto.
    dir: textDir(a.title),
    words: wordCount(a),
    dateStr: a.publishedAt ? formatWhen(a.publishedAt, now) : null,
    categories: a.categories.map((c) => c.split('/').join(' › ')).join(', ') || null,
    feedTitle: a.feedTitle || null,
    quickView,
    search: `${a.title} ${a.author ?? ''} ${quickView}`.toLowerCase(),
  };
};

/** Ask the server to summarize an article. Sends the blurb the reader already
 *  saw so the model only adds what the blurb doesn't cover. `redundant` is true
 *  when the article adds nothing beyond the blurb. Throws on real failure
 *  (incl. 501 when SUMMARY_API_KEY isn't configured). */
const fetchSummary = async (
  a: FreshRSSArticle,
): Promise<{ summary: string; redundant: boolean; format: SummaryFormat }> => {
  const res = await fetch('/api/summarize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: stripText(a.contentHtml), blurb: quickViewText(a) }),
  });
  const data = (await res.json().catch(() => null)) as {
    summary?: string;
    redundant?: boolean;
    format?: SummaryFormat;
    error?: string;
  } | null;
  if (!res.ok || !data) throw new Error(data?.error || `summarize ${res.status}`);
  const format: SummaryFormat = data.format === 'bullets' ? 'bullets' : 'prose';
  if (data.redundant) return { summary: '', redundant: true, format };
  if (!data.summary) throw new Error(data.error || `summarize ${res.status}`);
  return { summary: data.summary, redundant: false, format };
};

/** Render a summary: bullet digests (long articles) as a real list, short
 *  prose as a paragraph. The model is told to emit "- " lines for bullets. */
const SummaryBody = ({ summary, format }: { summary: string; format: SummaryFormat }) => {
  if (format !== 'bullets') return <>{summary}</>;
  const items = summary
    .split('\n')
    .map((line) => line.replace(/^\s*[-*•]\s*/, '').trim())
    .filter(Boolean);
  if (items.length < 2) return <>{summary}</>;
  return (
    <ul className='list-disc space-y-1 ps-5'>
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
};

const SWIPE_THRESHOLD = 80;

/** Horizontal swipe-to-dismiss wrapper (touch). `touch-action: pan-y` keeps
 *  vertical list scrolling native while we own horizontal gestures. */
const SwipeRow = ({ onDismiss, children }: { onDismiss: () => void; children: ReactNode }) => {
  const [dx, setDx] = useState(0);
  const startX = useRef<number | null>(null);
  const startY = useRef(0);
  const axis = useRef<'h' | 'v' | null>(null);
  const dragging = useRef(false);

  const onTouchStart = (e: TouchEvent) => {
    startX.current = e.touches[0]!.clientX;
    startY.current = e.touches[0]!.clientY;
    axis.current = null;
    dragging.current = true;
  };
  const onTouchMove = (e: TouchEvent) => {
    if (startX.current === null) return;
    const ddx = e.touches[0]!.clientX - startX.current;
    const ddy = e.touches[0]!.clientY - startY.current;
    if (axis.current === null && (Math.abs(ddx) > 8 || Math.abs(ddy) > 8)) {
      axis.current = Math.abs(ddx) > Math.abs(ddy) ? 'h' : 'v';
    }
    if (axis.current === 'h') setDx(ddx);
  };
  const onTouchEnd = () => {
    dragging.current = false;
    if (axis.current === 'h' && Math.abs(dx) > SWIPE_THRESHOLD) {
      setDx(dx > 0 ? 700 : -700);
      window.setTimeout(onDismiss, 150);
    } else {
      setDx(0);
    }
    startX.current = null;
    axis.current = null;
  };

  return (
    <div className='bg-error/10 relative overflow-hidden'>
      <div
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        style={{
          transform: `translateX(${dx}px)`,
          transition: dragging.current ? 'none' : 'transform 0.2s ease-out',
          touchAction: 'pan-y',
        }}
      >
        {children}
      </div>
    </div>
  );
};

/**
 * One article row. Memoized on primitives: without this, every selection move
 * (j/k), every expand/fold, and every undo expiry re-rendered all N rows —
 * each one redoing the derived string work above.
 */
interface ArticleRowProps {
  article: FreshRSSArticle;
  view: ArticleView;
  expanded: boolean;
  selected: boolean;
  opening: boolean;
  summarizing: boolean;
  noAdd: boolean;
  /** Opened at least once before (opening does not mark read). */
  visited: boolean;
  /** Show the source feed in the byline (the stream spans multiple feeds). */
  showFeedName: boolean;
  summary: CachedSummary | undefined;
  onTitleClick: (a: FreshRSSArticle) => void;
  onOpen: (a: FreshRSSArticle) => void;
  onDismiss: (a: FreshRSSArticle) => void;
  onSummarize: (a: FreshRSSArticle) => void;
  onFold: () => void;
  registerRef: (id: string, el: HTMLDivElement | null) => void;
}

const ArticleRow = memo(function ArticleRow({
  article: a,
  view,
  expanded,
  selected,
  opening,
  summarizing,
  noAdd,
  visited,
  showFeedName,
  summary,
  onTitleClick,
  onOpen,
  onDismiss,
  onSummarize,
  onFold,
  registerRef,
}: ArticleRowProps) {
  const _ = useTranslation();
  return (
    <SwipeRow onDismiss={() => onDismiss(a)}>
      <div
        ref={(el) => registerRef(a.id, el)}
        className={clsx(
          expanded ? 'border-base-300 bg-base-200/30 border-y-2' : 'bg-base-100',
          // Keyboard selection marker — an inline-start bar rather than a
          // ring, so it reads correctly in both LTR and RTL.
          selected && 'border-primary border-s-4',
        )}
      >
        <div className='flex items-stretch'>
          <button
            type='button'
            dir={view.dir}
            onClick={() => onTitleClick(a)}
            // Only the row being opened goes inert. Disabling the whole
            // queue turned one slow article into a frozen-looking list.
            disabled={opening}
            className='hover:bg-base-200/50 flex min-w-0 flex-1 flex-col gap-1 px-4 py-3 text-start disabled:opacity-60'
          >
            <span
              className={clsx(
                'flex items-center gap-2',
                // Already-opened articles read as "seen": you backed out of it
                // rather than finishing, and it stayed in the queue.
                visited ? 'text-base-content/60 font-normal' : 'font-medium',
              )}
            >
              {opening && <span className='loading loading-spinner loading-xs shrink-0' />}
              <span>{a.title}</span>
            </span>
            <span className='text-base-content/50 text-xs'>
              {[
                // Which feed this came from matters when the open stream is a
                // folder spanning several; categories are folder labels, not
                // the source name.
                showFeedName ? view.feedTitle : null,
                a.author,
                view.categories,
                view.words ? _('{{count}} words', { count: view.words.toLocaleString() }) : null,
                view.dateStr,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </button>
          <button
            type='button'
            onClick={() => onDismiss(a)}
            aria-label={_('Mark read')}
            title={_('Mark read')}
            className='text-base-content/30 hover:text-error hidden shrink-0 items-center px-3 sm:flex'
          >
            <MdClose className='h-5 w-5' />
          </button>
        </div>
        {expanded && (
          <div className='px-4 pb-3'>
            <p dir={view.dir} className='text-base-content/80 text-[15px]'>
              {view.quickView}
            </p>
            {summarizing && (
              <span className='text-base-content/50 mt-2 flex items-center gap-1 text-xs'>
                <span className='loading loading-spinner loading-xs' />
                {_('Summarizing…')}
              </span>
            )}
            {summary?.summary && (
              <div
                dir={view.dir}
                className='bg-base-200/70 border-primary/60 mt-2 rounded-md border-s-2 px-3 py-2'
              >
                <span className='text-base-content/50 mb-1 flex items-center gap-1 text-xs font-medium'>
                  <MdAutoAwesome className='h-3.5 w-3.5' />
                  {_('AI summary')}
                </span>
                <div dir={view.dir} className='text-base-content/80 text-[15px]'>
                  <SummaryBody summary={summary.summary} format={summary.format} />
                </div>
              </div>
            )}
            {noAdd && !summary && (
              <span className='text-base-content/50 mt-2 flex items-center gap-1 text-xs'>
                <MdAutoAwesome className='h-3.5 w-3.5' />
                {_('The blurb already covers it — nothing to add.')}
              </span>
            )}
            <div className='mt-3 flex items-center justify-center gap-2'>
              <button
                type='button'
                onClick={onFold}
                className='btn btn-ghost btn-sm min-h-11 gap-1'
              >
                <MdExpandLess className='h-5 w-5' />
                {_('Fold')}
              </button>
              <button
                type='button'
                onClick={() => onSummarize(a)}
                disabled={summarizing}
                className='btn btn-ghost btn-sm min-h-11 gap-1'
              >
                <MdAutoAwesome className='h-5 w-5' />
                {_('Summarize')}
              </button>
              <button
                type='button'
                onClick={() => onOpen(a)}
                disabled={opening}
                className='btn btn-ghost btn-sm text-primary min-h-11 gap-1'
              >
                {opening ? (
                  <span className='loading loading-spinner loading-xs' />
                ) : (
                  <MdMenuBook className='h-5 w-5' />
                )}
                {_('Read')}
              </button>
              <button
                type='button'
                onClick={() => onDismiss(a)}
                className='btn btn-ghost btn-sm hover:text-error min-h-11 gap-1'
              >
                <MdDeleteOutline className='h-5 w-5' />
                {_('Delete')}
              </button>
            </div>
          </div>
        )}
      </div>
    </SwipeRow>
  );
});

export const ArticleList = () => {
  const _ = useTranslation();
  const { settings } = useSettingsStore();
  // Granular selectors: subscribing to the whole store re-rendered the entire
  // list on ANY store change — including summary writes and unread-count
  // deltas that don't affect what's on screen.
  const articles = useFeedsStore((s) => s.articles);
  const loading = useFeedsStore((s) => s.loading);
  const error = useFeedsStore((s) => s.error);
  const continuation = useFeedsStore((s) => s.continuation);
  const loadMore = useFeedsStore((s) => s.loadMore);
  const summaries = useFeedsStore((s) => s.summaries);
  const setSummary = useFeedsStore((s) => s.setSummary);
  const dismissArticle = useFeedsStore((s) => s.dismissArticle);
  const currentStreamId = useFeedsStore((s) => s.currentStreamId);
  const currentTitle = useFeedsStore((s) => s.currentTitle);
  const openStream = useFeedsStore((s) => s.openStream);
  const lastOpenedArticleId = useFeedsStore((s) => s.lastOpenedArticleId);
  const openArticles = useFeedsStore((s) => s.openArticles);
  const hydrateOpenArticles = useFeedsStore((s) => s.hydrateOpenArticles);
  const openFeedArticle = useOpenFeedArticle();
  const [opening, setOpening] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState<Set<string>>(new Set());
  // Articles whose summary came back "nothing to add beyond the blurb".
  const [noAdd, setNoAdd] = useState<Set<string>>(new Set());
  // Keyboard selection (desktop). Null until the first j/k so the list doesn't
  // show a selection ring to touch users who never press a key.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  // Mirrors of the transient state the handlers READ. Depending on the state
  // itself would rebuild every handler on each change, defeating the memoized
  // rows; refs let the handlers stay identity-stable.
  const openingRef = useRef<string | null>(null);
  const summarizingRef = useRef<Set<string>>(new Set());
  const expandedRef = useRef<string | null>(null);
  openingRef.current = opening;
  summarizingRef.current = summarizing;
  expandedRef.current = expandedId;
  const fr = settings.freshrss;

  // Derived per-article data, computed once per queue change (see ArticleView).
  const views = useMemo(() => {
    const map = new Map<string, ArticleView>();
    const now = Date.now();
    for (const a of articles) map.set(a.id, deriveView(a, now));
    return map;
  }, [articles]);

  // Client-side filter over the loaded queue. Matches title, blurb and author so
  // "that piece about X" is findable without a round-trip to the server — now
  // against the prebuilt lowercase blob, so a keystroke costs a substring scan
  // rather than re-stripping every article's HTML three times.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return articles;
    return articles.filter((a) => views.get(a.id)?.search.includes(q));
  }, [articles, query, views]);

  // Keep the selection valid as the queue changes (dismissals, filtering).
  useEffect(() => {
    if (selectedId && !visible.some((a) => a.id === selectedId)) {
      setSelectedId(visible[0]?.id ?? null);
    }
  }, [visible, selectedId]);

  // Returning from an article remounts this list, which reappeared scrolled to
  // the top. Put the reader back where they were: scroll the article they just
  // came out of into view and select it. Runs once per mount.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || !lastOpenedArticleId) return;
    const row = rowRefs.current.get(lastOpenedArticleId);
    if (!row) return; // that article has left the queue (marked read)
    restoredRef.current = true;
    setSelectedId(lastOpenedArticleId);
    row.scrollIntoView?.({ block: 'center' });
  }, [lastOpenedArticleId, visible]);

  // Articles already opened at least once, so the list can distinguish
  // "looked at it, came back" from untouched. Opening does NOT mark read.
  useEffect(() => {
    hydrateOpenArticles();
  }, [hydrateOpenArticles]);
  // Only worth the byline space when the queue actually spans feeds (a folder
  // or the aggregate stream); inside a single feed it's the same name on every
  // row.
  const showFeedName = useMemo(() => new Set(articles.map((a) => a.feedId)).size > 1, [articles]);
  const openedIds = useMemo(
    () => new Set(Object.values(openArticles).map((v) => v.greaderId)),
    [openArticles],
  );

  const selectedIndex = visible.findIndex((a) => a.id === selectedId);

  const select = (index: number) => {
    const next = visible[Math.max(0, Math.min(index, visible.length - 1))];
    if (!next) return;
    setSelectedId(next.id);
    // Optional-call: not every environment implements scrollIntoView.
    rowRefs.current.get(next.id)?.scrollIntoView?.({ block: 'nearest' });
  };

  // Generate (or regenerate) the LLM summary for an article. `silent` suppresses
  // the error toast — used for the auto path so a blurb-less article that can't
  // be summarized just keeps its first-paragraph fallback.
  // Handlers are memoized on stable deps so the memoized rows actually hold:
  // transient state they need to READ (opening / summarizing / expanded) is
  // mirrored into refs, since depending on that state directly would give
  // every row a new callback identity on each change.
  const runSummary = useCallback(
    async (a: FreshRSSArticle, silent = false) => {
      if (summarizingRef.current.has(a.id)) return;
      setSummarizing((prev) => new Set(prev).add(a.id));
      setNoAdd((prev) => {
        if (!prev.has(a.id)) return prev;
        const next = new Set(prev);
        next.delete(a.id);
        return next;
      });
      try {
        const { summary, redundant, format } = await fetchSummary(a);
        if (redundant) {
          setNoAdd((prev) => new Set(prev).add(a.id));
          // Cache the verdict too, so a reload doesn't re-ask the model only to
          // be told again that the blurb already covers it.
          setSummary(a.id, { summary: '', format, redundant: true });
        } else {
          setSummary(a.id, { summary, format });
        }
      } catch (e) {
        if (!silent) {
          eventDispatcher.dispatch('toast', {
            message: _('Summary failed: {{error}}', { error: String(e) }),
            type: 'error',
          });
        }
      } finally {
        setSummarizing((prev) => {
          const next = new Set(prev);
          next.delete(a.id);
          return next;
        });
      }
    },
    [_, setSummary],
  );

  const openArticle = useCallback(
    async (a: FreshRSSArticle) => {
      if (openingRef.current) return;
      setOpening(a.id);
      try {
        const ok = await openFeedArticle(a);
        if (!ok) throw new Error('import returned no book');
      } catch (e) {
        eventDispatcher.dispatch('toast', {
          message: _('Could not open article: {{error}}', { error: String(e) }),
          type: 'error',
        });
      } finally {
        // ALWAYS clear: on the success path the reader replaces this view, but a
        // navigation that never happens (or a back into a still-mounted list)
        // must not leave the queue stuck behind a permanent "opening" flag.
        setOpening(null);
      }
    },
    [_, openFeedArticle],
  );

  // First tap on the title opens the quick view; a second tap opens the full
  // article in the reader. Summaries are NOT auto-generated — the user taps the
  // Summarize button, and the summary is added below the blurb (not a replacement).
  const onTitleClick = useCallback(
    (a: FreshRSSArticle) => {
      if (expandedRef.current === a.id) void openArticle(a);
      else setExpandedId(a.id);
    },
    [openArticle],
  );

  const onFold = useCallback(() => setExpandedId(null), []);
  const registerRef = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) rowRefs.current.set(id, el);
    else rowRefs.current.delete(id);
  }, []);
  const onSummarize = useCallback((a: FreshRSSArticle) => void runSummary(a), [runSummary]);
  const onOpen = useCallback((a: FreshRSSArticle) => void openArticle(a), [openArticle]);

  // Dismiss without opening: drop it from the queue immediately (snappy) and
  // mark it read in FreshRSS in the background. The undo window itself lives
  // in the store, because the Undo control is rendered by the page header —
  // an inline bar here pushed the whole queue down as it appeared and expired.
  const dismiss = useCallback(
    async (a: FreshRSSArticle) => {
      dismissArticle(a);
      if (!fr) return;
      try {
        await new FreshRSSClient().markRead(a.id);
      } catch (e) {
        eventDispatcher.dispatch('toast', {
          message: _('Mark-read failed: {{error}}', { error: String(e) }),
          type: 'error',
        });
      }
    },
    [_, fr, dismissArticle],
  );
  const onDismiss = useCallback((a: FreshRSSArticle) => void dismiss(a), [dismiss]);

  // Desktop keyboard flow. `n` reads the NEXT article straight away — the
  // queue-burning move: it opens the one after the selection (or the first),
  // without a detour through the list.
  useFeedShortcuts({
    onNext: () => select(selectedIndex < 0 ? 0 : selectedIndex + 1),
    onPrev: () => select(selectedIndex < 0 ? 0 : selectedIndex - 1),
    onOpen: () => {
      const a = visible[selectedIndex] ?? visible[0];
      if (a) void openArticle(a);
    },
    onNextArticle: () => {
      const a = visible[selectedIndex + 1] ?? visible[0];
      if (a) {
        setSelectedId(a.id);
        void openArticle(a);
      }
    },
    onDone: () => {
      const a = visible[selectedIndex];
      if (a) void dismiss(a);
    },
    onSummarize: () => {
      const a = visible[selectedIndex];
      if (a) {
        setExpandedId(a.id);
        void runSummary(a);
      }
    },
    onRefresh: () => {
      if (fr && currentStreamId) void openStream(fr, currentStreamId, currentTitle);
    },
    onSearch: () => {
      setSearchOpen(true);
      // The field mounts on this state change, so focus after paint.
      requestAnimationFrame(() => searchRef.current?.focus());
    },
    onEscape: () => {
      if (query || searchOpen) {
        setQuery('');
        setSearchOpen(false);
      } else if (expandedId) {
        setExpandedId(null);
      }
    },
  });

  if (loading && articles.length === 0) {
    return (
      <div className='p-8 text-center'>
        <span className='loading loading-spinner' />
      </div>
    );
  }
  // Only take over the screen when there is nothing to take over FROM. A failed
  // "Load more" used to throw away a 40-article queue (and any pending undo)
  // and leave a bare error string with no way back.
  if (error && articles.length === 0) {
    return (
      <div className='p-6 text-center text-sm'>
        <p className='text-error'>{error}</p>
        <button
          type='button'
          onClick={() =>
            fr && currentStreamId && void openStream(fr, currentStreamId, currentTitle)
          }
          className='btn btn-ghost btn-sm text-primary mt-3 min-h-11'
        >
          {_('Retry')}
        </button>
      </div>
    );
  }
  if (articles.length === 0) {
    return <div className='text-base-content/60 p-8 text-center text-sm'>{_('Queue clear ✓')}</div>;
  }

  return (
    <div
      className='mx-auto max-w-[600px] text-[16px] leading-[1.5]'
      style={{ fontFamily: "'Open Sans', sans-serif" }}
    >
      {(searchOpen || query) && (
        <div className='border-base-200 flex items-center gap-2 border-b px-4 py-2'>
          <MdSearch className='text-base-content/40 h-5 w-5 shrink-0' />
          <input
            ref={searchRef}
            type='search'
            dir='auto'
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={_('Filter articles…')}
            aria-label={_('Filter articles')}
            className='min-w-0 flex-1 bg-transparent text-[15px] outline-hidden'
          />
          <button
            type='button'
            onClick={() => {
              setQuery('');
              setSearchOpen(false);
            }}
            aria-label={_('Close search')}
            className='text-base-content/40 hover:text-base-content flex h-10 w-10 shrink-0 items-center justify-center'
          >
            <MdClose className='h-5 w-5' />
          </button>
        </div>
      )}
      {error && (
        <div className='border-base-200 bg-error/10 flex items-center gap-2 border-b px-4 py-2 text-[15px]'>
          <span className='text-error min-w-0 flex-1 truncate'>{error}</span>
          <button
            type='button'
            onClick={() => fr && void loadMore(fr)}
            className='btn btn-ghost btn-sm text-primary min-h-11'
          >
            {_('Retry')}
          </button>
        </div>
      )}
      {visible.length === 0 && (
        <div className='text-base-content/60 p-8 text-center text-sm'>{_('No matches')}</div>
      )}
      <div className='divide-base-200 divide-y'>
        {visible.map((a) => (
          <ArticleRow
            key={a.id}
            article={a}
            view={views.get(a.id)!}
            expanded={expandedId === a.id}
            selected={a.id === selectedId}
            opening={opening === a.id}
            summarizing={summarizing.has(a.id)}
            noAdd={noAdd.has(a.id)}
            visited={openedIds.has(a.id)}
            showFeedName={showFeedName}
            summary={summaries[a.id]}
            onTitleClick={onTitleClick}
            onOpen={onOpen}
            onDismiss={onDismiss}
            onSummarize={onSummarize}
            onFold={onFold}
            registerRef={registerRef}
          />
        ))}
      </div>
      {continuation && !query && (
        <button
          type='button'
          onClick={() => fr && void loadMore(fr)}
          disabled={loading}
          className='text-primary min-h-12 w-full px-4 py-3 text-center text-sm'
        >
          {loading ? _('Loading…') : _('Load more')}
        </button>
      )}
    </div>
  );
};
