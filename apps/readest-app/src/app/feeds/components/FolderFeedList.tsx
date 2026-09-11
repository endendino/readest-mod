'use client';

import { useState } from 'react';
import { MdChevronRight, MdKeyboardArrowDown } from 'react-icons/md';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { useFeedsStore } from '@/store/feedsStore';

export const FolderFeedList = () => {
  const _ = useTranslation();
  const { settings } = useSettingsStore();
  const { folders, feeds, loading, error, openStream } = useFeedsStore();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const fr = settings.freshrss;

  const open = (streamId: string, title: string) => {
    if (fr) void openStream(fr, streamId, title);
  };

  const toggle = (folderId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  };

  if (loading && folders.length === 0 && feeds.length === 0) {
    return (
      <div className='p-8 text-center'>
        <span className='loading loading-spinner' />
      </div>
    );
  }
  if (error) {
    return <div className='text-error p-6 text-sm'>{error}</div>;
  }

  const uncategorized = feeds.filter((f) => !f.folderId);

  return (
    <div className='divide-base-200 divide-y'>
      {folders.map((folder) => {
        const folderFeeds = feeds.filter((f) => f.folderId === folder.id);
        const isOpen = expanded.has(folder.id);
        return (
          <div key={folder.id}>
            <div className='hover:bg-base-200/50 flex items-center'>
              {folderFeeds.length > 0 ? (
                <button
                  type='button'
                  onClick={() => toggle(folder.id)}
                  aria-label={isOpen ? _('Hide feeds') : _('Show feeds')}
                  aria-expanded={isOpen}
                  className='text-base-content/40 hover:text-base-content flex h-11 w-11 shrink-0 items-center justify-center'
                >
                  {isOpen ? (
                    <MdKeyboardArrowDown className='h-5 w-5' />
                  ) : (
                    <MdChevronRight className='h-5 w-5 rtl:rotate-180' />
                  )}
                </button>
              ) : (
                <span className='w-11 shrink-0' />
              )}
              <button
                type='button'
                dir='auto'
                onClick={() => open(folder.id, folder.label)}
                className='flex min-h-11 min-w-0 flex-1 items-center justify-between gap-3 py-3 pe-4 text-start'
              >
                <span className='min-w-0 truncate font-medium'>{folder.label}</span>
                <span className='text-base-content/60 shrink-0 text-sm'>{folder.unreadCount}</span>
              </button>
            </div>
            {isOpen &&
              folderFeeds.map((feed) => (
                <button
                  key={feed.id}
                  type='button'
                  dir='auto'
                  onClick={() => open(feed.id, feed.title)}
                  className='hover:bg-base-200/50 flex min-h-11 w-full items-center justify-between gap-3 py-2 pe-4 ps-11 text-start'
                >
                  <span className='min-w-0 truncate text-sm'>{feed.title}</span>
                  <span className='text-base-content/50 shrink-0 text-xs'>{feed.unreadCount}</span>
                </button>
              ))}
          </div>
        );
      })}
      {uncategorized.length > 0 && (
        <div>
          <div className='text-base-content/50 px-4 pt-4 pb-1 text-xs font-medium uppercase'>
            {_('Uncategorized')}
          </div>
          {uncategorized.map((feed) => (
            <button
              key={feed.id}
              type='button'
              dir='auto'
              onClick={() => open(feed.id, feed.title)}
              className='hover:bg-base-200/50 flex min-h-11 w-full items-center justify-between gap-3 px-4 py-2 text-start'
            >
              <span className='min-w-0 truncate text-sm'>{feed.title}</span>
              <span className='text-base-content/50 shrink-0 text-xs'>{feed.unreadCount}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
