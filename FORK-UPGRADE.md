# Upgrading this fork to a new upstream Readest release

This repository is a personalised, self-hosted build of [Readest](https://github.com/readest/readest):
no Readest account or login, a FreshRSS feed reader, the RSVP speed reader, WebDAV sync behind a
Caddy reverse proxy, bundled Hebrew/Latin fonts, and a handful of small patches ("pins") inside
upstream files that keep all of that working. Upstream ships roughly every two weeks; this document
is the procedure for pulling a release in without losing any of it.

The deploy branch is `rss-reader-0.11.17`. The name is historical and **must not change**:
`.github/workflows/build-image.yml` triggers on it, builds the production image on GitHub
Actions and publishes `ghcr.io/endendino/readest-client`. The VPS never builds; `/opt/rebuild.sh`
pulls the image, keeps the outgoing one as `readest-client:rollback-YYYYMMDD` (one, for 21 days)
and swaps the container.

## History

| Upstream | Date | Method | What bit |
| --- | --- | --- | --- |
| 0.11.10 → 0.11.17 | 2026-07-04 | Port: fork re-applied on a fresh branch (62 commits → 4 `feat(port)` commits) | On-VPS Docker builds ran out of disk and caused an outage → builds moved to Actions |
| 0.11.18 | 2026-07-08 | `git merge v0.11.18` | Paywall constant auto-merged to `true` (only its comment conflicted); foliate-js submodule kept the old pin |
| 0.11.20 | 2026-07-21 | `git merge v0.11.20` | Upstream moved the transient-book filter to another file; WebDAV readiness refactored out from under its patch; foliate-js stale again → `fork-pins.test.ts` was written |
| 0.12.8 | 2026-09-11 | `git merge v0.12.8` (443 upstream commits) | Tailwind 4/daisyUI 5 codemod did not reach fork-only files; assetBundler rewritten around the fork's proxy flag; `useRouter` dropped under the Feeds button; jsdom `StorageEvent` rejected the fork's localStorage shim; two "keep both" hunks cut inside a block |

Each pre-merge HEAD is tagged `pre-<version>-rollback`.

## Procedure

### 0. Start clean

```bash
git status --short            # must be empty apart from the two local-only files below
git fetch origin --tags
git tag --sort=-creatordate | head
```

- Commit any finished fork work first. Do not carry WIP through the merge.
- `apps/readest-app/next.config.mjs` (dev `allowedDevOrigins`, service worker disabled in dev) and
  `apps/readest-app/wrangler.toml` (readest.com routes removed) carry **local-only** edits that are
  never committed. Stash them: `git stash push -m local-only -- apps/readest-app/next.config.mjs apps/readest-app/wrangler.toml`.
- `git submodule update packages/tauri` etc. if `git status` shows submodule drift; the merge needs a clean index.
- Baseline: `cd apps/readest-app && pnpm test -- run --reporter=dot` so pre-existing failures are known.

### 1. Rollback point

```bash
git tag pre-<ver>-rollback
git push fork pre-<ver>-rollback
```

### 2. Look before merging

```bash
git merge-tree --write-tree --name-only HEAD v<ver>   # conflict list without touching the tree
git diff v<old> pre-<ver>-rollback -- <file>            # the fork's own delta in each conflicting file
git diff v<old> v<ver> -- <file>                        # what upstream did to it
git log --oneline v<old>..v<ver> -i --grep=migrat --grep=tailwind --grep=upgrade   # framework moves
git diff v<old> v<ver> -- .gitmodules 'packages/*' | grep Subproject                # submodule bumps/removals
```

Knowing the fork delta per file *before* resolving is what turns conflict resolution into
"re-apply this pin onto upstream's new shape" instead of guesswork.

### 3. Merge

```bash
git config merge.conflictstyle zdiff3      # shows the base, so you see what each side changed
git merge v<ver>
```

Resolution rules that have held up:

- **Fork feature next to upstream feature** (imports, union members, settings fields, JSX siblings):
  keep both. Check the closing brace after the hunk — twice now a "keep both" resolution left an
  interface or `describe` unclosed because the shared `}` sat outside the conflict region.
- **Upstream refactored the code a pin lives in**: take upstream's code and re-apply the pin in its
  new shape (`EnvContext` replica gate, `assetBundler` `useProxy`, `LibraryHeader` router).
- **Upstream shipped an equivalent of a fork patch**: retire the fork's (0.11.18: tombstone
  propagation; 0.12.8: the forward-only `view.goTo` after progress sync). Less fork surface.
- **Fork replaced an upstream UI** (RSVP WPM slider vs upstream's dropdown): keep the fork's, delete
  the now-dead upstream code and its tests with a `// FORK:` note.
- `pnpm-lock.yaml`: take upstream's, then `pnpm install` re-adds the fork's deps (`sharp`).
- Submodule pointers: take upstream's. The previous merges silently kept "ours" for
  `tauri-plugin-turso`; it only did not matter because the web image does not build Tauri.

### 4. Submodules and dependencies

```bash
git submodule sync
git submodule update --init packages/foliate-js packages/tauri packages/simplecc-wasm packages/js-mdict packages/qcms \
  apps/readest-app/src-tauri/plugins/tauri-plugin-turso apps/readest-app/src-tauri/plugins/tauri-plugin-webview-upgrade \
  apps/readest-app/.claude/skills/gstack
git submodule status                       # no '+' or '-' rows
pnpm install
```

Removed submodules leave their old checkout behind as an untracked directory (`packages/tauri-plugins`
in 0.12.x); move it out of the tree.

### 5. Gates, in this order

```bash
cd apps/readest-app
pnpm exec tsc --noEmit                     # first: syntax slips from resolution show up here
pnpm exec biome lint .
(cd ../.. && pnpm exec biome format .)     # or `pnpm -w format` to fix
pnpm exec dotenv -e .env -e .env.test.local -- vitest run src/__tests__/fork/fork-pins.test.ts
pnpm test -- run --reporter=dot            # full suite
```

If a pin test fails, re-apply the pin; never relax the test. Upstream tests that assert the
paywall (`isCloudSyncAllowed(... ) === false`) are adapted to the fork's ungated contract, asserting
upstream's plan logic one level down (`isCloudSyncInPlan`). Upstream tests that render the stats
tracker without a book need one, because the fork never opens the statistics DB for a book-less or
transient document.

### 6. Framework migrations must reach fork-only files

Upstream's codemods only run over upstream's files. When a release migrates a framework (Tailwind 4 in
0.12.x), apply the same renames to **fork-authored lines only**: for each file that differs from
`v<ver>`, treat a line as fork-authored if it is absent from `git show v<ver>:<file>`, and rewrite class
tokens inside string literals. Print every rename as a list and read it; the 0.12.8 pass produced two
false positives (`!remoteDeleted.has(...)` and `!important` inside test strings) that had to be reverted.
The rename table used: `rounded→rounded-sm`, `rounded-sm→rounded-xs`, `shadow→shadow-sm`,
`shadow-sm→shadow-xs`, `blur→blur-sm`, `outline-none→outline-hidden`, `flex-shrink-0→shrink-0`,
`flex-grow→grow`, `!x→x!`, `label-text→text-sm`, `input-bordered`/`select-bordered` dropped.

### 7. Build and run the real artifact

```bash
docker build --target production-stage \
  --build-arg NEXT_PUBLIC_APP_PLATFORM=web --build-arg NEXT_PUBLIC_FRESHRSS_ENABLED=true \
  -t readest-client:merge-test .
docker run -d --name readest-merge-test -p 3100:3000 readest-client:merge-test
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3100/          # 200
curl -s http://localhost:3100/sw.js | head -3                            # kill-switch, not a serwist SW
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3100/fonts/Heebo-400.woff2
docker exec readest-merge-test node -e 'require("/app/node_modules/sharp")'   # /api/img needs it
```

Then open `http://localhost:3100/library`, `/feeds` and Settings → Integrations in a browser and look at
the fork screens (Feeds button in the library header, article list, FreshRSS form, RSVP overlay).
Finish with `docker rm -f readest-merge-test`.

### 8. Commit, restore, ship

- One self-contained merge commit: the conflict list, how each was resolved, and the gate results.
  Extra fork guards or docs go in a follow-up commit.
- `git stash pop` the local-only files. Expect a conflict in `next.config.mjs` whenever upstream touched
  it: keep upstream's code, re-add only the dev origins and `disable: isDev`.
- Push the branch (this triggers the image build) and watch the run:
  `git push fork rss-reader-0.11.17 && gh run watch`.
- On the VPS: `/opt/rebuild.sh`, then `docker ps` / logs, then a hard refresh on each device
  (the kill-switch SW makes this a one-time thing).

## Rollback

- Git: `git reset --hard pre-<ver>-rollback` on the branch (force-push only if it was pushed).
- VPS: retag `readest-client:rollback-YYYYMMDD` as the live tag and `docker compose up -d readest-client`.

## The pins

`apps/readest-app/src/__tests__/fork/fork-pins.test.ts` is the authoritative list; each test names the
incident it protects against. In short: cloud sync never paywalled; WebDAV works with empty
(proxy-injected) credentials and without a username; feed articles (transient books) never reach the
library, the cloud index, file sync or reading statistics; tombstoned remote dirs are not re-adopted
but are still GC-able; the replica WASM engine only starts with a real cloud session; the WASM database
circuit-breaks; WebDAV/FreshRSS can be seeded from build env; and the FreshRSS wiring inside upstream
files (image proxy, reader buttons, library button, settings sub-page, fonts) is present.
