---
name: release-desktop
description: Cut, build, and publish a Plainly macOS desktop release locally (version bump, CHANGELOG, desktop:dist, GitHub draft release, publish, feed check). Use when asked to "make a release", "push an update", "make a gh release", "cut 0.1.x", or "ship a new version" of Plainly.
---

# Release Plainly (macOS, local)

Releases are built locally on an Apple Silicon Mac. The `v*` tag trigger in `.github/workflows/release.yml` is off on purpose (see `docs/desktop-release.md`). Repo: `dataguyofprocol/plainly`.

Ask the user before each step marked **(ask)**. Do not ask before the other steps.

## 1. Pre-flight

- `git switch main && git pull --ff-only origin main`. If tracked files have changes, stop and ask; do not stash or discard.
- `xcodebuild -version` must report Xcode 26 or later. The mac icon needs actool 26.
- Local gates (GitHub CI may be unavailable):
  - `pre-commit run --all-files` (lint, typecheck)
  - `pre-commit run --all-files --hook-stage pre-push` (tests, native tests, build, smokes)

  If a gate fails, stop and report it. Never release over a red gate.

## 2. Version (ask)

- Previous version: `gh release list -R dataguyofprocol/plainly --limit 5`.
- Ask with AskUserQuestion. The next patch is the recommended option, with the next minor as the alternative.
- `npm version <v> --no-git-tag-version`. This touches package.json and package-lock.json and creates no tag.

## 3. Notes (ask)

- Source material: `git log --format='%h %s' v<prev>..HEAD`, plus the bodies of the PRs merged since then (`gh pr list -R dataguyofprocol/plainly --state merged --search "merged:>=<prev-date>" --json number,title,body`).
- Write for learners, not developers, matching the existing CHANGELOG.md entries:
  - one plain summary line, "Plainly <v> …";
  - then bullets that start with a **bold lead**, each describing a change the user can see: what was wrong before, and what happens now;
  - no internal names, file paths, PR numbers, or refactors.
- Show the draft to the user and apply their edits.
- Insert it as the top section of `CHANGELOG.md`: `## <v> — <YYYY-MM-DD>`, then a blank line, then the notes.
- In `README.md` → `## What's new`, replace the summary line with `**<v>:** <summary, lower-case start>`. Keep the CHANGELOG link line.

## 4. Commit and push

```bash
git add package.json package-lock.json CHANGELOG.md README.md
git commit -m "chore(release): <v>"
git push origin main
```

Releases go straight to `main` (see the 0.1.4–0.1.6 history). The pre-push hook runs the full gate again. Let it run.

## 5. Build

Run `npm run desktop:dist > <scratchpad>/dist.log 2>&1` in the background (several minutes). Wait for the completion notification; do not poll. Then check `tail -25` of the log and `grep -iE "error|smoke"` on it.

## 6. Check the build

```bash
A=dist/mac-arm64/Plainly.app/Contents/Info.plist
defaults read "$PWD/$A" CFBundleShortVersionString   # must be <v>
defaults read "$PWD/$A" NSMicrophoneUsageDescription # must exist (dictation)
head -3 dist/latest-mac.yml                          # version: <v>
ls dist/Plainly-<v>-arm64-mac.zip dist/Plainly-<v>-arm64-mac.zip.blockmap dist/latest-mac.yml scripts/install.sh
```

If the release carries a specific fix, also grep the bundled server under `dist/mac-arm64/Plainly.app/Contents/Resources/server` for a string the fix added.

## 7. Draft release

Write the body to `<scratchpad>/notes-<v>.md`: the CHANGELOG section's text (without its `##` heading), then this footer, copied exactly:

````markdown
If you already have Plainly, it picks this up on its own within a day, or right away from Plainly → Check for Updates….

## Install

- **macOS (Apple Silicon):** paste this into Terminal:

  ```sh
  curl -fsSL https://github.com/dataguyofprocol/plainly/releases/latest/download/install.sh | sh
  ```

  It installs Plainly in Applications and opens it. After that, Plainly updates itself. There's no download link because Plainly isn't signed with an Apple Developer ID yet, and macOS blocks unsigned apps downloaded in a browser.
- **Windows and Linux:** builds are coming; for now, run from source.

Plainly is based on [LearnHarness](https://github.com/amosblomqvist/learnharness) by Amos Blomqvist, licensed AGPL-3.0; see [NOTICE](https://github.com/dataguyofprocol/plainly/blob/main/NOTICE).
````

```bash
SHA=$(git rev-parse HEAD)
gh release create v<v> -R dataguyofprocol/plainly --draft --target "$SHA" --title "Plainly <v>" --notes-file <scratchpad>/notes-<v>.md
gh release upload v<v> -R dataguyofprocol/plainly dist/Plainly-<v>-arm64-mac.zip dist/Plainly-<v>-arm64-mac.zip.blockmap dist/latest-mac.yml scripts/install.sh
gh release view v<v> -R dataguyofprocol/plainly --json isDraft,targetCommitish,assets --jq '{isDraft,targetCommitish,assets:[.assets[].name]}'
```

## 8. Publish (ask)

Ask "Publish v<v>?" and wait for a yes. Then:

```bash
gh release edit v<v> -R dataguyofprocol/plainly --draft=false --latest
```

## 9. Check the live feed

```bash
B=https://github.com/dataguyofprocol/plainly/releases/latest/download
curl -fsSL $B/latest-mac.yml | head -1        # version: <v>
curl -fsSLI $B/install.sh | grep -i "^HTTP"   # 200 after redirects
git ls-remote --tags origin v<v>              # the tag gh created
```

Report the release URL. Installed copies update within 24h, or at once from Plainly → Check for Updates….

## Gotchas from past releases

- `--target` needs the **full** SHA. A short SHA is rejected.
- Pass `-R dataguyofprocol/plainly` on every `gh` call. The checkout has an `upstream` remote, so gh can pick the wrong repo.
- Write release notes and PR bodies to a file and pass `--notes-file` / `--body-file`. An inline heredoc to `gh` has hung before.
- Do not push a `v*` tag by hand. `gh release create` makes the tag when the draft is published.
- `latest/download` serves only the newest **published, non-prerelease** release. The `demo-video` pre-release does not affect it.
