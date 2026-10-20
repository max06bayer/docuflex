# Releasing Docuflex

Every batch of fixes ships as its own version (0.9.0, 0.9.1, 0.9.2, …). The
website's download button always serves the newest GitHub release
(`/download` redirects to `releases/latest`), so publishing a release updates it.

## How releases are built

| Platform | Built by | Ends up in the release via |
| --- | --- | --- |
| Windows x64 (`.exe`) | GitHub Actions, `windows-x64` job | the workflow's `release` job |
| Linux x64 (`.AppImage`, `.deb`) | GitHub Actions, `linux-x64` job | the workflow's `release` job |
| Arch / CachyOS (`.pkg.tar.zst`) | GitHub Actions, `arch-linux-x64` job | the workflow's `release` job |
| macOS Apple Silicon (`.dmg`) | a Mac (`npm run build` in `desktop/`) | `gh release upload` from that Mac |

Pushing a tag `v*` runs `.github/workflows/desktop-native-builds.yml`. Its `release`
job creates the GitHub release **as a draft** and attaches the Windows and Linux
files directly from the runners. **Never download the CI artifacts to a local
machine and upload them again**: that step is automated, and big uploads from a
laptop connection stall.

## Steps

1. **Bump the version** everywhere (same number in all files):
   `package.json`, `package-lock.json` (2 places), `desktop/package.json`,
   `desktop/package-lock.json` (2 places), `desktop/src-tauri/tauri.conf.json`,
   `desktop/src-tauri/Cargo.toml`, `desktop/src-tauri/Cargo.lock` (the
   `docuflex-desktop` entry), and `desktop/scripts/package-arch-linux.sh`
   (`pkgver` and the output file name).
2. **Merge to `main` through a PR.** `main` is protected. Only merge when the user asks.
3. **Tag `main` and push the tag.** This starts the builds and the draft release:
   ```bash
   git tag v0.9.2 origin/main && git push origin v0.9.2
   ```
4. **Build the macOS DMG on a Mac** from the same commit:
   ```bash
   cd desktop && npm run build
   ```
   This builds the release app `Docuflex.app`, not the side-by-side
   "Docuflex Redesign" variant (`build:redesign`). It provisions its own pinned
   Python (no local runtime needed) and runs the offline smoke tests. Package it
   as `Docuflex_<version>_macOS_arm64.dmg` (`hdiutil create … -format UDZO`, with
   an `Applications` symlink), then check it with `hdiutil verify`.
5. **When the workflow's draft exists, add the DMG and the checksums:**
   ```bash
   gh release upload v0.9.2 Docuflex_0.9.2_macOS_arm64.dmg
   ```
   Then download the four CI files' checksums, or compute them with
   `shasum -a 256`, into `SHA256SUMS.txt`, and upload that too.
6. **Write the release notes** (what changed, plus the download list) and publish:
   ```bash
   gh release edit v0.9.2 --notes-file notes.md --draft=false --latest
   ```

## Rules

- Releases are public and outward-facing. Publish only when the user asks for it.
- Never change or delete an older release unless the user explicitly asks.
- If a CI build fails because a third-party download host is unreachable
  (for example `soft.rubypdf.com` for the Windows pdf2htmlEX), re-run just the
  failed job (`gh run rerun <id> --failed`). Don't publish a release with
  missing platforms.
- The website deploys from `main` through Coolify; merging to `main` updates docuflex.eu.
