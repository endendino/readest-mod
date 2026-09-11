'use client';

import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { useRouter } from 'next/navigation';
import { MdArrowBack, MdDoneAll, MdRefresh } from 'react-icons/md';
import { FreshRSSClient } from '@/services/freshrss/greaderClient';
import { eventDispatcher } from '@/utils/event';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { useFeedsStore } from '@/store/feedsStore';
import { pokeLocalObsidianPull } from '@/services/freshrss/obsidianExport';
import { FolderFeedList } from './components/FolderFeedList';
import { ArticleList } from './components/ArticleList';

/** Narrow view of AppService's protected `fs` used by the cache sweep. */
type AppFsReadDir = (path: string, base: string) => Promise<{ path: string }[]>;

/** Marks the synthetic history entry backing the open-stream (article list) view. */
const STREAM_HASH = '#list';

export default function FeedsPage() {
  const _ = useTranslation();
  const router = useRouter();
  const { appService } = useEnv();
  const { settings, setSettings } = useSettingsStore();
  // Granular selectors — subscribing to the whole store re-rendered the header
  // (and with it the article list) on every summary write and unread delta.
  const currentStreamId = useFeedsStore((s) => s.currentStreamId);
  const currentTitle = useFeedsStore((s) => s.currentTitle);
  const clearCurrentStream = useFeedsStore((s) => s.clearCurrentStream);
  const loadFoldersAndFeeds = useFeedsStore((s) => s.loadFoldersAndFeeds);
  const clearStreamLocally = useFeedsStore((s) => s.clearStreamLocally);
  const pendingUndo = useFeedsStore((s) => s.pendingUndo);
  const undoDismiss = useFeedsStore((s) => s.undoDismiss);
  // Only the COUNT matters here (mark-all-read gating + its confirm text), so
  // don't re-render the header on every article-array identity change.
  const articleCount = useFeedsStore((s) => s.articles.length);
  const openStream = useFeedsStore((s) => s.openStream);
  const loading = useFeedsStore((s) => s.loading);
  const [markingAll, setMarkingAll] = useState(false);
  const [confirmingAll, setConfirmingAll] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    },
    [],
  );
  const fr = settings.freshrss;

  // Restore the dismissed article locally, then un-read it server-side so the
  // undo propagates to every client (the dismiss already marked it read).
  const onUndo = async () => {
    const article = undoDismiss();
    if (!article || !fr?.enabled) return;
    try {
      await new FreshRSSClient().markUnread(article.id);
    } catch (e) {
      eventDispatcher.dispatch('toast', {
        message: _('Undo failed: {{error}}', { error: String(e) }),
        type: 'error',
      });
    }
  };

  // The settings store boots EMPTY ({}) and is normally hydrated from disk by
  // the library page — Providers loads settings for its own boot work but
  // never writes them into the store. On a direct load / reload of /feeds the
  // library never mounts, so without this the page would read
  // `settings.freshrss` as undefined forever and falsely claim FreshRSS is
  // not connected. Hydrate here, exactly like the library does.
  const settingsHydrated = !!settings.globalViewSettings;
  useEffect(() => {
    if (settingsHydrated || !appService) return;
    appService
      .loadSettings()
      .then((loaded) => {
        // Re-check: the library (or a second effect run) may have hydrated
        // the store while we were reading from disk — don't clobber it.
        if (!useSettingsStore.getState().settings.globalViewSettings) {
          setSettings(loaded);
        }
      })
      .catch((e) => console.warn('feeds: settings hydration failed', e));
  }, [settingsHydrated, appService, setSettings]);

  useEffect(() => {
    if (fr?.enabled) void loadFoldersAndFeeds(fr);
  }, [fr, loadFoldersAndFeeds]);

  // Re-fetch unread counts when the window regains focus. The store keeps them
  // honest locally as you read, but another device (or the FreshRSS web UI)
  // marking things read is only visible on a real refresh.
  useEffect(() => {
    if (!fr?.enabled) return;
    const onFocus = () => {
      if (!useFeedsStore.getState().currentStreamId) void loadFoldersAndFeeds(fr);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [fr, loadFoldersAndFeeds]);

  // Opening Feeds on the desktop nudges the local clip-puller (a loopback
  // launchd agent) so notes saved from OTHER devices (phone) get pulled into
  // the Obsidian vault now. No-op on machines without the agent.
  useEffect(() => {
    pokeLocalObsidianPull();
  }, []);

  // Sweep stale staged article files (Cache/feed-*.epub). Articles are staged
  // per open and released when the reader closes, but files from crashed
  // sessions / older builds accumulated indefinitely (190+ on long-lived
  // installs). Best-effort: any failure is ignored.
  useEffect(() => {
    if (!appService) return;
    (async () => {
      try {
        const fs = (appService as unknown as { fs: { readDir: AppFsReadDir } }).fs;
        const entries = await fs.readDir('', 'Cache');
        for (const entry of entries) {
          const name = entry.path.split('/').pop() ?? entry.path;
          if (/^feed-.*\.epub$/.test(name)) {
            await appService.deleteFile(name, 'Cache').catch(() => {});
          }
        }
      } catch {
        /* Cache dir missing or listing unsupported — nothing to sweep */
      }
    })();
  }, [appService]);

  // The stream (article-list) view gets its own history entry, so the SYSTEM
  // back gesture walks list → folders → library exactly like the header
  // button. Without this the hierarchy lives only in zustand and back pops
  // real browser history, exiting /feeds entirely. The entry is marked with a
  // hash — not history.state, which Next owns — and an already-marked entry
  // (returning from the reader lands on it) is not re-pushed.
  useEffect(() => {
    if (currentStreamId && window.location.hash !== STREAM_HASH) {
      window.history.pushState(window.history.state, '', STREAM_HASH);
    }
  }, [currentStreamId]);
  // Consuming the marked entry (system back, header back, mark-all-read)
  // closes the stream view.
  useEffect(() => {
    const onPop = () => {
      if (useFeedsStore.getState().currentStreamId) clearCurrentStream();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [clearCurrentStream]);
  // A reload while in a stream resets the store to the folder view but leaves
  // the marked entry current — strip it so the first back press isn't dead.
  useEffect(() => {
    if (!useFeedsStore.getState().currentStreamId && window.location.hash === STREAM_HASH) {
      window.history.replaceState(window.history.state, '', window.location.pathname);
    }
  }, []);

  // Close the stream view: consume the synthetic entry when it's there (keeps
  // the stack balanced; the popstate handler does the store clear), plain
  // clear otherwise.
  const closeStream = () => {
    if (window.location.hash === STREAM_HASH) window.history.back();
    else clearCurrentStream();
  };

  const onBack = () => {
    if (currentStreamId) closeStream();
    else router.back();
  };

  // Mark the whole open stream read. Bounded to the newest article this client
  // has actually seen, so anything that arrives mid-request stays unread.
  const markAllRead = async () => {
    if (!currentStreamId || !fr?.enabled || markingAll) return;
    const count = articleCount;
    if (count === 0) return;
    // Two-tap confirm rather than window.confirm: inside the TWA that pops
    // Chrome's system dialog with the origin in the title — the one place the
    // flow visibly stopped feeling like an app. Matches the undo-bar idiom.
    if (!confirmingAll) {
      setConfirmingAll(true);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirmingAll(false), 4000);
      return;
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    setConfirmingAll(false);
    setMarkingAll(true);
    const newest = useFeedsStore
      .getState()
      .articles.reduce((max, a) => Math.max(max, a.publishedAt ?? 0), 0);
    try {
      await new FreshRSSClient().markAllRead(currentStreamId, newest || undefined);
      clearStreamLocally(currentStreamId);
      closeStream();
    } catch (e) {
      eventDispatcher.dispatch('toast', {
        message: _('Mark-all-read failed: {{error}}', { error: String(e) }),
        type: 'error',
      });
    } finally {
      setMarkingAll(false);
    }
  };

  return (
    <div className='bg-base-100 mx-auto flex h-dvh w-full max-w-3xl flex-col'>
      <header className='border-base-200 flex items-center gap-2 border-b px-2 py-2'>
        <button
          type='button'
          onClick={onBack}
          className='btn btn-ghost btn-sm btn-circle'
          aria-label={_('Back')}
        >
          <MdArrowBack className='h-5 w-5' />
        </button>
        {/* While an undo is pending it takes the title's place: the control
            belongs in the header (next to mark-all-read) rather than as an
            inline bar, which pushed the whole queue down as it came and went. */}
        {pendingUndo ? (
          <div className='flex min-w-0 flex-1 items-center gap-2'>
            <span className='text-base-content/70 min-w-0 flex-1 truncate text-sm' dir='auto'>
              {_('Marked read: {{title}}', { title: pendingUndo.title })}
            </span>
            <button
              type='button'
              onClick={() => void onUndo()}
              className='btn btn-ghost btn-sm text-primary shrink-0'
            >
              {_('Undo')}
            </button>
          </div>
        ) : (
          <h1 className='min-w-0 flex-1 truncate text-lg font-semibold' dir='auto'>
            {currentStreamId ? currentTitle : _('Feeds')}
          </h1>
        )}
        {currentStreamId && (
          <button
            type='button'
            onClick={() => fr && void openStream(fr, currentStreamId, currentTitle)}
            disabled={loading}
            aria-label={_('Refresh')}
            title={_('Refresh')}
            className='btn btn-ghost btn-sm btn-circle shrink-0'
          >
            <MdRefresh className={clsx('h-5 w-5', loading && 'animate-spin')} />
          </button>
        )}
        {currentStreamId && articleCount > 0 && (
          <button
            type='button'
            onClick={() => void markAllRead()}
            disabled={markingAll}
            aria-label={confirmingAll ? _('Confirm mark all read') : _('Mark all read')}
            title={_('Mark all read')}
            className={clsx(
              'btn btn-sm shrink-0',
              confirmingAll ? 'btn-primary gap-1' : 'btn-ghost btn-circle',
            )}
          >
            {markingAll ? (
              <span className='loading loading-spinner loading-xs' />
            ) : (
              <MdDoneAll className='h-5 w-5' />
            )}
            {confirmingAll && !markingAll && (
              <span className='text-xs'>{_('Read all {{count}}?', { count: articleCount })}</span>
            )}
          </button>
        )}
      </header>
      <div className='min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]'>
        {!settingsHydrated ? (
          // Settings still loading from disk — showing "not connected" here
          // would be a false negative on every direct load of this page.
          <div className='flex justify-center p-8'>
            <span className='loading loading-spinner loading-md opacity-40' />
          </div>
        ) : !fr?.enabled ? (
          <div className='text-base-content/60 p-6 text-sm'>
            {_('FreshRSS is not connected. Configure it in Settings → Integrations → FreshRSS.')}
          </div>
        ) : currentStreamId ? (
          <ArticleList />
        ) : (
          <FolderFeedList />
        )}
      </div>
    </div>
  );
}
