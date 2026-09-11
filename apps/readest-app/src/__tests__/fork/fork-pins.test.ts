import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { CLOUD_SYNC_REQUIRES_PREMIUM, isCloudSyncAllowed } from '@/utils/access';
import { buildAuthHeaders } from '@/services/sync/providers/webdav/client';

/**
 * FORK PIN GUARDS
 * ===============
 * This self-hosted build has NO Readest account: no login, no Supabase session,
 * WebDAV credentials injected by a reverse proxy. Upstream assumes the
 * opposite, so a handful of small patches ("pins") inside upstream files keep
 * the build working. Upstream ships a release roughly every two weeks and this
 * fork merges them.
 *
 * Every pin below has already survived three upstream merges — but one of them
 * silently CHANGED FILES during the v0.11.20 merge (the library transient
 * filter moved from useLibraryFileSync into runLibrarySync), and the WebDAV
 * readiness check was refactored out from under its patch. The v0.12.8 merge
 * rewrote assetBundler's fetch loop around the fork's image-proxy flag and
 * dropped the router the library Feeds button navigates with. That is exactly
 * how a pin gets lost: not deleted deliberately, just quietly refactored away.
 *
 * If a pin is lost, the failure is SILENT and severe — sync simply stops, or
 * feed articles pollute the shelf again. These tests make it LOUD instead.
 *
 * ⚠️ If one of these fails after an upstream merge: do NOT "fix" the test.
 * Re-apply the pin in whatever shape the new upstream code needs, then update
 * the assertion to match.
 */

const SRC = path.join(process.cwd(), 'src');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');

describe('fork pin: cloud sync is never paywalled', () => {
  test('CLOUD_SYNC_REQUIRES_PREMIUM stays false', () => {
    // Upstream intends to re-gate third-party cloud sync to paid plans. This
    // build has no account at all, so every device reads as `free`; flipping
    // this to true disables WebDAV sync everywhere with no user-visible error.
    expect(CLOUD_SYNC_REQUIRES_PREMIUM).toBe(false);
  });

  test('a plan-less (free) device is allowed to sync', () => {
    expect(isCloudSyncAllowed('free', false)).toBe(true);
  });
});

describe('fork pin: reverse-proxy WebDAV auth', () => {
  test('empty credentials send NO Authorization header', () => {
    // The gateway (Caddy basic_auth) injects the real credentials upstream. If
    // we send `Basic Og==` (an empty user:pass) it overrides the browser's
    // cached credential and every request 401s.
    expect(buildAuthHeaders('', '')).toEqual({});
  });

  test('real credentials are still sent (direct WebDAV keeps working)', () => {
    const headers = buildAuthHeaders('user', 'pass');
    expect(headers['Authorization']).toMatch(/^Basic /);
  });

  test('a username alone is enough to authenticate', () => {
    expect(buildAuthHeaders('user', '')['Authorization']).toMatch(/^Basic /);
  });

  test('the WebDAV provider omits the header for empty creds on the Tauri path too', () => {
    const src = read('services/sync/providers/webdav/WebDAVProvider.ts');
    expect(src).toMatch(/settings\.username \|\| settings\.password/);
  });
});

describe('fork pin: WebDAV is usable without a username', () => {
  test('"configured" is decided by serverUrl alone', () => {
    // Reverse-proxy mode carries an EMPTY username by design. Upstream's
    // predicate is `serverUrl && username`, which would render this build's
    // WebDAV permanently "not connected".
    const src = read('components/settings/IntegrationsPanel.tsx');
    expect(src).toMatch(/webdavConfigured = !!settings\.webdav\?\.serverUrl;/);
    expect(src).not.toMatch(/webdavConfigured =[^\n]*username/);
  });
});

describe('fork pin: feed articles never reach the library or the cloud index', () => {
  test('library persistence filters transient books', () => {
    // Feed articles are imported as transient books. Letting their rows into
    // library.json is what caused the 190-phantom-book shelf pollution.
    const src = read('services/libraryService.ts');
    expect(src).toMatch(/\.filter\(\(b\) => !b\.transient\)/);
    expect(src).toMatch(/!b\.transient/);
  });

  test('library sync excludes transient books from the push', () => {
    const src = read('services/sync/file/runLibrarySync.ts');
    expect(src).toMatch(/library\.filter\(\(b\) => !b\.transient\)/);
  });

  test('the reader never syncs a transient or born-dead book', () => {
    // Article books are born tombstoned; pushing their config/cover/file is
    // what created the Readest/books/<hash>/ residue on the server.
    const src = read('app/reader/hooks/useFileSync.ts');
    expect(src).toMatch(/book\.transient \|\| book\.deletedAt/);
  });

  test('Book carries the transient marker', () => {
    expect(read('types/book.ts')).toMatch(/transient\?: boolean/);
  });
});

describe('fork pin: tombstoned remote dirs are not re-adopted — but ARE still GC-able', () => {
  const engine = read('services/sync/file/engine.ts');

  test('the drift scan skips hashes tombstoned in the remote index', () => {
    // Without this, a device whose storage was evicted re-adopts deleted books
    // (incl. old feed articles) as live phantom shelf entries.
    expect(engine).toMatch(/remoteDeleted/);
    expect(engine).toMatch(/!remoteDeleted\.has\(entry\.name\)/);
  });

  test('the fork filter runs AFTER remoteHashDirs is recorded', () => {
    // Subtle but critical interaction: upstream's GC deletes the remote dirs of
    // tombstoned books, and it only considers dirs recorded in `remoteHashDirs`
    // during the same listing. If the fork's skip were applied BEFORE that
    // `add`, tombstoned dirs would never be recorded and would never be
    // reclaimed — the server would accumulate residue forever.
    const addIdx = engine.indexOf('remoteHashDirs.add(entry.name)');
    const filterIdx = engine.indexOf('!remoteDeleted.has(entry.name)');
    expect(addIdx).toBeGreaterThan(-1);
    expect(filterIdx).toBeGreaterThan(-1);
    expect(addIdx).toBeLessThan(filterIdx);
  });

  test('remote tombstones propagate onto local live rows', () => {
    // Lets an already-polluted device heal itself instead of fighting forever.
    expect(engine).toMatch(/tombstone propagation|resurrected/i);
  });
});

describe('fork pin: no-login posture', () => {
  test('the replica WASM engine only starts with a real cloud session', () => {
    // Its publish path no-ops without a user, and on Firefox its OPFS writes
    // panic in a tight loop — the "page is slowing down your browser" report.
    const src = read('context/EnvContext.tsx');
    expect(src).toMatch(/hasCloudSession/);
    expect(src).toMatch(/replicaDeviceId && hasCloudSession/);
  });

  test('the wasm database circuit-breaks instead of looping on failure', () => {
    const src = read('services/database/webDatabaseService.ts');
    expect(src).toMatch(/MAX_CONSECUTIVE_FAILURES/);
    expect(src).toMatch(/disabled after repeated/);
  });

  test('feed articles are excluded from reading statistics', () => {
    // Every progress change writes through the turso WASM engine on the MAIN
    // THREAD — the same engine already behind a circuit breaker because it
    // stalls and panics. Running it per page turn of every feed article was a
    // direct cause of mid-reading stalls and whole-tab freezes.
    //
    // If this fails after an upstream merge, RE-APPLY the pin: a transient
    // book must yield no bookMd5, and the stats DB must not even be opened
    // for one. Do NOT relax this test.
    const src = read('app/reader/components/ReadingStatsTracker.tsx');
    expect(src).toMatch(/book\?\.transient \? undefined : book\?\.hash/);
    // The DB-open effect must bail BEFORE StatisticsDb.open for a feed article.
    const guardIdx = src.indexOf('if (!bookMd5) return;');
    const openIdx = src.indexOf('StatisticsDb.open');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(openIdx);
  });
});

describe('fork pin: build-time self-hosting config', () => {
  test('WebDAV and FreshRSS can be seeded from build env', () => {
    // A fresh browser (or one whose storage was evicted) must come up already
    // pointed at the self-hosted services, with no manual setup.
    const src = read('services/constants.ts');
    expect(src).toMatch(/NEXT_PUBLIC_WEBDAV_ENABLED/);
    expect(src).toMatch(/NEXT_PUBLIC_WEBDAV_URL/);
    expect(src).toMatch(/NEXT_PUBLIC_FRESHRSS_ENABLED/);
  });
});

describe('fork pin: FreshRSS feature wiring inside upstream files', () => {
  // These are the fork's own feature, not a behavioural patch — but every one
  // of them lives inside a file upstream edits constantly, and each of the
  // v0.11.18 / v0.11.20 / v0.12.8 merges conflicted on at least one of them.

  test('feed article images are fetched through the same-origin proxy on web', () => {
    // Plain web builds are CORS-blocked on cross-origin images; without the
    // proxy flag every feed article renders with broken pictures.
    const src = read('services/send/conversion/assetBundler.ts');
    expect(src).toMatch(/useProxy\?: boolean/);
    expect(src).toMatch(/\/api\/img\?url=/);
    expect(read('services/freshrss/articleDoc.ts')).toMatch(/useProxy: true/);
  });

  test('the reader mounts the feed Done / Save buttons', () => {
    const src = read('app/reader/components/ReaderContent.tsx');
    expect(src).toMatch(/<FeedDoneButton /);
    expect(src).toMatch(/<FeedSaveButton /);
  });

  test('the library header can navigate to /feeds', () => {
    expect(read('app/library/components/LibraryHeader.tsx')).toMatch(/router\.push\('\/feeds'\)/);
  });

  test('settings expose the FreshRSS integration sub-page', () => {
    const src = read('components/settings/IntegrationsPanel.tsx');
    expect(src).toMatch(/requestedSubPage === 'freshrss'/);
    expect(src).toMatch(/freshrssStatus/);
  });

  test('FreshRSS settings exist in the settings type and defaults', () => {
    expect(read('types/settings.ts')).toMatch(/freshrss: FreshRSSSettings;/);
    expect(read('services/constants.ts')).toMatch(/freshrss: DEFAULT_FRESHRSS_SETTINGS,/);
  });

  test('the bundled reading fonts are declared in the global stylesheet', () => {
    // Atkinson Hyperlegible + Heebo (RSVP) and Open Sans (feeds UI, Hebrew)
    // are self-hosted woff2 so reading works offline, with no Google CDN.
    const css = read('styles/globals.css');
    for (const face of ['Atkinson Hyperlegible', 'Heebo', 'Open Sans']) {
      expect(css).toContain(`font-family: '${face}';`);
    }
    expect(css).toMatch(/url\('\/fonts\/Heebo-400\.woff2'\)/);
  });
});
