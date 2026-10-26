# Rename: LearnHarness → Plainly

Status: **approved 2026-10-27, implemented.** See "Deviations during implementation" at the end.

## Decisions (owner, 2026-10-27)

| Topic | Decision |
|---|---|
| Name | **Plainly** (display), `plainly` (package / lowercase contexts) |
| Depth | Visible surfaces only. Internals stay: `LH_*` env vars, `lh:*` IPC/event names, `lh-*` CSS classes, `x-learnharness-desktop` header. Keeps upstream merges clean. |
| Data folder | `…/Plainly/` (userData). On first launch, if `Plainly/` is absent and `LearnHarness/` exists, **copy** it across; the old folder is never touched. |
| Repo | `dataguyofprocol/plainly` (does not exist yet) |
| Bundle ID | `app.plainly.Plainly` |
| Mac signing | Unsigned for now (ad-hoc), notarization off |
| Logo | Refine the round-two mark first (fading lines → one clear line + amber dot, teal tile), then build icons from the approved version |
| Attribution | Parth Batra as author; Amos Blomqvist credited as contributor and original author; "fork of LearnHarness" line in README, About panel, and a new `NOTICE` |
| Version | Restart at `0.1.0`; README notes the fork point (LearnHarness 0.3.7) |
| Website | Download links → GitHub Releases of `dataguyofprocol/plainly`; delete `notify-website.yml` |

## Steps

### 0. Logo refinement (blocks step 4)
A short round of variations on the round-two mark, checked at 16, 24, 32, 128 and 1024px, light and dark. Owner picks one. Output: a 24px-grid in-app mark and a 1024px tile.

### 1. Identity and packaging
- `package.json`: `name` → `plainly`, `version` → `0.1.0`, `author` → Parth Batra, add `contributors: [Amos Blomqvist]`, `homepage` → `https://github.com/dataguyofprocol/plainly`, `desktopName` → `plainly.desktop`, `description` reworded with the new name. `desktop:dist` drops `APPLE_KEYCHAIN_PROFILE` / `APPLE_TEAM_ID`. Regenerate `package-lock.json` name fields.
- `electron-builder.yml`: `appId: app.plainly.Plainly`, `productName: Plainly`, mic usage string, `publish.owner/repo` → `dataguyofprocol/plainly`, `mac.notarize: false`, `mac.identity: "-"` (ad-hoc; Apple Silicon refuses to run fully unsigned code). Header comment renamed.
- `electron/main.cjs`: `PRODUCT_NAME = "Plainly"` (so userData becomes `Plainly` / `Plainly-dev`); "up to date" dialog text; `app.setAboutPanelOptions` with the fork credit line and AGPL notice.
- `.github/workflows/release.yml`: binary paths (`Plainly.app`, `Plainly.exe`, `dist/linux-unpacked/plainly`), artifact name `plainly-*`; mac job builds unsigned (no signing secrets required).
- Delete `.github/workflows/notify-website.yml`.
- `scripts/verify-release.ts`: `PRODUCT_NAME`, expected package name, comments with artifact names.

### 2. Data-folder migration
- New `electron/migrate-data.cjs`, called in `main.cjs` **after** `app.setName` and the dev `-dev` suffix, **before** the single-instance lock and before anything reads userData.
- Rule: target = `userData` (`…/Plainly` or `…/Plainly-dev`); source = same path with the last segment `LearnHarness` / `LearnHarness-dev`. Run only when target does not exist and source does. Copy recursively (`fs.cpSync`, preserving modes, so `auth.json` stays 0600) into a temp sibling, then rename into place, so a crash mid-copy never leaves a half folder that blocks a retry. Log the result to `logs/main.log`. Never delete or modify the source.
- Skip the copy if a LearnHarness instance is running? → Not detectable reliably; documented risk: quit LearnHarness before first Plainly launch.
- Tests: `tests/desktop-platform.test.ts` (or a new `tests/migrate-data.test.ts`) — copies when only source exists; no-op when target exists; no-op when neither; source untouched; partial temp dir from a failed run is cleaned and retried.

### 3. User-visible strings
- `components/v4/shell.tsx` (sidebar wordmark + two `aria-label`s), `components/update-banner.tsx`, `components/home.tsx`, `components/settings/chatgpt-connection.tsx`, `components/settings/subscription-connections.tsx` (2), `components/settings/keys-section.tsx`, `proxy.ts` error text.
- Strings sent to providers: `electron/chatgpt.cjs` (sign-in page text, `agent_name_hint`), `electron/subscriptions.cjs` (`agentName`), `src/agent/chatgpt-stream.ts` tool namespace description (namespace **name** `learnharness` stays — internal). `src/agent/models.ts` user agent derives from `package.json` name, so it becomes `plainly/0.1.0` automatically.
- Agent skill: rename `skills/learnharness/` → `skills/plainly/` and `name: plainly` (the Agent Skills spec requires folder = name; users see this name when they install it). Update its data-folder table and `_data.py` default path to `Plainly`, **falling back to `LearnHarness` when `Plainly` is absent**, so the skill still finds un-migrated data.
- Comments that say "LearnHarness" in app code: left alone (internal, merge-friendly), except the ones above that sit next to changed lines.

### 4. Logo and icons (after step 0)
- `build/icon-flat.svg` → new flat tile; rerun `node scripts/make-icons.mjs` → `build/icon.ico`, `build/icon.png`.
- `build/icon.icon/` (macOS 26 Liquid Glass): replace `Assets/*.svg` with the mark's layers and set the `fill` to the brand teal in `icon.json`.
- `build/icon.icns`: regenerate from the 1024 render with `iconutil`.
- `build/background.png` / `@2x` (DMG background): check for the old name or mark; redraw if present.
- `components/ui/icon.tsx` `LogoMark`: redraw on the 24px grid; doc comment updated.
- README banners: replace `docs/assets/lh_banner_{light,dark}.{svg,png}` with `plainly_banner_*`.

### 5. Docs and attribution
- `README.md`: new name, banner, tagline, download links → GitHub Releases, a "Plainly is a fork of LearnHarness by Amos Blomqvist" section linking upstream, fork point 0.3.7, AGPL notice. Screenshots retaken only if they show the old name or mark.
- New `NOTICE`: original copyright (Amos Blomqvist), fork statement, date of modification, AGPL-3.0.
- `skills/plainly/LICENSE`: keep as is (original copyright stands); check whether it needs a modification note.
- `docs/development.md`, `docs/desktop-release.md`: name, unsigned-mac instructions; remove the upstream Apple team ID.
- `.claude/launch.json`: no change needed (uses `LH_DATA_DIR`, which stays).

### 6. Tests
Update assertions that pin the old identity: `tests/desktop-platform.test.ts` (homepage, desktopName), `tests/session-identity.test.ts`, `tests/verify-release.test.ts`, `tests/server-title-guard.test.ts`, `tests/chatgpt-*.test.ts`, `tests/provider-*.test.ts`, `tests/desktop-api.test.ts`, `tests/skills/*.py` (skill path). Tests that only reference internal identifiers (`LH_*`, the header) stay.

### 7. Verify
- `npm run typecheck`, `npm run lint`, `npm test`, skill tests (`tests/skills`).
- `grep -ri "learn ?harness"` → every remaining hit is either internal-by-decision, attribution, or historical docs (`docs/archive`, `docs/release-0.3.md`), each listed in the PR.
- `npm run dev` in the preview: wordmark, logo, Home copy, update banner.
- Local packaged build (`electron-builder --mac --arm64`, unsigned): app is named Plainly, opens after right-click → Open, About panel shows the credit, and on this Mac the existing `LearnHarness` data is copied into `Plainly` and appears in the app.

## Known consequences
- **No auto-update on macOS while unsigned.** Squirrel.Mac only installs updates for code-signed apps. Windows (already unsigned) and Linux still update. Mac users reinstall manually until a Developer ID is set up.
- In-app updates point at `dataguyofprocol/plainly`, which must exist and be **public** before the first release (anonymous update reads).
- Plainly installs beside LearnHarness (different bundle ID); both can run, sharing nothing after the one-time copy.
- Upstream merges: internals unchanged, so conflicts are limited to the files touched in steps 1, 3 and 5.

## Out of scope
Domain purchase, trademark search, creating the GitHub repo, setting the git remote, Apple Developer enrolment.

## Deviations during implementation

- **Migration trigger and placement.** Electron creates the userData folder before `main.cjs` runs (measured), so "target does not exist" could never fire. The target now counts as fresh while it holds neither `data/` nor `auth.json`, and those two are moved in last so an interrupted copy is retried. The call sits right **after** the single-instance lock (only one instance copies) and before `main()`. Chromium lock files and rebuildable caches are not copied.
- **Hardened runtime off on macOS.** electron-builder warns that ad-hoc signing plus hardened runtime rejects Electron's pre-signed frameworks; `hardenedRuntime: false` until real signing returns (it is only required for notarization).
- **User agent.** It was hardcoded as `learnharness/<version>`, not derived from `package.json`; changed by hand to `plainly/<version>`.
- **Page title.** `app/layout.tsx` said "Learning Harness"; now "Plainly" (the window/tab title).
- **`.deb` maintainer email.** Linux packaging requires an author email; it is the `dataguyofprocol` GitHub no-reply address (mirrors upstream's no-reply policy), not a personal address.
- **`package.json` description** left unchanged (it never contained the name).
- **README banners** ship as PNG only (rendered with the app's Literata); the old SVG banners were removed.
- **Shipped Pi attribution note** (`docs/compaction-accounting.md`, packaged as `licenses/pi-compaction.md`) now says Plainly.
- **Not done here:** retaking the README teaching screenshot (needs a choice of what lesson to show publicly).
