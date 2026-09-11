import clsx from 'clsx';
import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { eventDispatcher } from '@/utils/event';
import { FreshRSSClient } from '@/services/freshrss/greaderClient';
import type { FreshRSSSettings } from '@/types/settings';
import type { FreshRSSFolder, FreshRSSFeed } from '@/types/freshrss';
import SubPageHeader from '../SubPageHeader';
import { SettingLabel, Tips } from '../primitives';

interface FreshRSSFormProps {
  onBack: () => void;
}

const FreshRSSForm: React.FC<FreshRSSFormProps> = ({ onBack }) => {
  const _ = useTranslation();
  const { envConfig } = useEnv();
  const { settings, setSettings, saveSettings } = useSettingsStore();
  const router = useRouter();

  const fr = settings.freshrss;
  const [isTesting, setIsTesting] = useState(false);
  const [result, setResult] = useState<{ folders: FreshRSSFolder[]; feeds: FreshRSSFeed[] } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [obsidianFolder, setObsidianFolder] = useState(fr?.obsidianFolder ?? 'Obsidian/Readest');

  const persist = async (next: Partial<FreshRSSSettings>) => {
    // Read the LATEST settings from the store, not the render closure: on
    // mobile the WebDAV sync hooks write settings (deviceId, lastSyncedAt)
    // concurrently, and rebuilding the object from a stale snapshot would
    // silently clobber those writes — or lose OUR `enabled: true` when a
    // sibling write lands right after (the "test works but Feeds says not
    // connected" failure). Same pattern as useFileSync.updateLastSyncedAt.
    const latest = useSettingsStore.getState().settings;
    const newSettings = { ...latest, freshrss: { ...latest.freshrss, ...next } };
    setSettings(newSettings);
    await saveSettings(envConfig, newSettings);
  };

  const handleTest = async () => {
    setIsTesting(true);
    setError(null);
    setResult(null);
    try {
      const { folders, feeds } = await new FreshRSSClient().listFoldersAndFeeds();
      setResult({ folders, feeds });
      // A successful test means the server is configured — surface the feature.
      await persist({ enabled: true });
    } catch (e) {
      setError(String(e));
      eventDispatcher.dispatch('toast', {
        message: _('FreshRSS connection failed'),
        type: 'error',
      });
    } finally {
      setIsTesting(false);
    }
  };

  const unreadTotal = result?.feeds.reduce((n, f) => n + f.unreadCount, 0) ?? 0;

  return (
    <div className='w-full'>
      <SubPageHeader
        parentLabel={_('Integrations')}
        currentLabel={_('FreshRSS')}
        description={_(
          'Read your FreshRSS feeds inside Readest. The connection is configured on the server (FRESHRSS_URL, FRESHRSS_USERNAME, FRESHRSS_API_PASSWORD), so credentials never touch this device and stay working even if browser storage is cleared.',
        )}
        onBack={onBack}
      />

      <div className='space-y-5'>
        <div className='flex justify-end'>
          <button
            type='button'
            onClick={handleTest}
            disabled={isTesting}
            className={clsx(
              'btn btn-primary h-10 min-h-10 rounded-lg border-0 px-5 text-sm font-medium',
              'focus-visible:ring-primary/40 focus-visible:outline-hidden focus-visible:ring-2',
              isTesting && 'opacity-60',
            )}
          >
            {isTesting ? (
              <span className='loading loading-spinner loading-sm' />
            ) : (
              _('Test Connection')
            )}
          </button>
        </div>

        {error && (
          <div className='border-error/30 bg-error/10 text-error rounded-lg border px-4 py-3 text-sm'>
            {error}
          </div>
        )}

        {result && (
          <div className='card eink-bordered border-base-200 bg-base-100 overflow-hidden border'>
            <div className='border-base-200 border-b px-4 py-3 text-sm font-medium'>
              {_('Connected — {{folders}} folders, {{feeds}} feeds, {{unread}} unread', {
                folders: result.folders.length,
                feeds: result.feeds.length,
                unread: unreadTotal,
              })}
            </div>
            <div className='divide-base-200 max-h-64 divide-y overflow-y-auto'>
              {result.feeds.map((f) => (
                <div
                  key={f.id}
                  className='flex items-center justify-between gap-3 px-4 py-2 text-sm'
                >
                  <span className='min-w-0 truncate' dir='auto'>
                    {f.title}
                  </span>
                  <span className='text-base-content/60 shrink-0'>{f.unreadCount}</span>
                </div>
              ))}
              {result.feeds.length === 0 && (
                <div className='text-base-content/60 px-4 py-3 text-sm'>
                  {_(
                    'Connected, but no feeds were returned. Check that this account has subscriptions and that the GReader API is enabled in FreshRSS.',
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        <div className='card eink-bordered border-base-200 bg-base-100 overflow-hidden border'>
          <div className='divide-base-200 divide-y'>
            <label className='flex min-h-14 items-center justify-between px-4'>
              <SettingLabel>{_('Enabled')}</SettingLabel>
              <input
                type='checkbox'
                className='toggle'
                checked={fr?.enabled ?? false}
                onChange={() => persist({ enabled: !fr?.enabled })}
              />
            </label>
            <label className='flex min-h-14 items-center justify-between px-4'>
              <SettingLabel>{_('Export highlights to Obsidian')}</SettingLabel>
              <input
                type='checkbox'
                className='toggle'
                checked={fr?.exportToObsidian ?? false}
                onChange={() => persist({ exportToObsidian: !fr?.exportToObsidian })}
              />
            </label>
            <div className='space-y-1.5 px-4 py-3'>
              <SettingLabel>{_('Obsidian clip folder')}</SettingLabel>
              <input
                type='text'
                className='input eink-bordered h-10 w-full text-sm focus:outline-hidden'
                spellCheck='false'
                autoCapitalize='off'
                placeholder='Obsidian/Readest'
                value={obsidianFolder}
                onChange={(e) => setObsidianFolder(e.target.value)}
                onBlur={() =>
                  persist({ obsidianFolder: obsidianFolder.trim() || 'Obsidian/Readest' })
                }
              />
              <p className='text-base-content/50 text-xs'>
                {_(
                  'WebDAV path where article clips are saved (relative to the WebDAV root). Must sit inside the folder your Obsidian WebDAV-sync plugin pulls into the vault.',
                )}
              </p>
            </div>
            <label className='flex min-h-14 items-center justify-between px-4'>
              <SettingLabel>{_('Auto-advance when RSVP finishes')}</SettingLabel>
              <input
                type='checkbox'
                className='toggle'
                checked={fr?.autoAdvanceOnRsvpEnd ?? true}
                onChange={() => persist({ autoAdvanceOnRsvpEnd: !fr?.autoAdvanceOnRsvpEnd })}
              />
            </label>
          </div>
        </div>

        <div className='flex justify-end'>
          <button
            type='button'
            onClick={() => router.push('/feeds')}
            className='btn btn-primary h-10 min-h-10 rounded-lg border-0 px-5 text-sm font-medium'
          >
            {_('Open Feeds')}
          </button>
        </div>

        <Tips>
          <li>
            {_(
              'Articles open as temporary documents — never added to your book library or synced via WebDAV.',
            )}
          </li>
          <li>
            {_(
              'Read/unread state lives in FreshRSS, so it stays in sync across all your devices and other readers.',
            )}
          </li>
        </Tips>
      </div>
    </div>
  );
};

export default FreshRSSForm;
