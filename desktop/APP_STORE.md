# Mac App Store distribution

The Store profile is separate from the GitHub download profile. It uses the
public Docuflex bundle identity for production. Local QA uses the separate
`com.docuflex.editor.storeqa` identity, container and ports, while retaining the
Docuflex name. It can run alongside the installed app; do not replace an
existing installation with the QA bundle. Preparing this
profile does not publish or upload anything.

## Build and local verification

From `desktop/`:

```sh
npm run build:appstore:qa
npm run check:appstore
```

`check:appstore` also requires a valid installed distribution certificate. An
ad-hoc QA build cannot be uploaded to App Store Connect. The local QA app is
`src-tauri/target-app-store/release/bundle/macos/Docuflex.app`; the normal
GitHub app's target and resources are separate.

The Store profile removes the native updater and its IPC permissions. The
PDFBox service is compiled to native machine code with a pinned Native Image
compiler, with no JVM, JARs or Java class files in the package. Bundled PyMuPDF
and Pillow perform raster operations over private pipes. The native backend
must pass document editing, image/alpha, Unicode, forms, encryption, OCR and
rotated-redaction checks before staging accepts it.

Translation engines and their native dependencies are installed at build time.
Only language model data is downloaded; the Store extractor rejects scripts,
native executables, symlinks and paths outside its destination. Qwen's macOS
runtime is bundled; only model data is pulled at runtime. Tectonic uses a
checksum-pinned complete local TeX ZIP, with no network bundle fallback.

The native compiler and complete TeX bundle are large build-time downloads.
They are checksum verified and cached under `.cache/`. Store staging and
build products are ignored by Git.

## Signing and upload

The account is an individual Apple Developer Program membership. One-time setup
in the developer account (keys and profiles stay outside this repository):

1. **Identifiers:** register the App ID `com.docuflex.editor` (explicit, macOS).
   No extra capabilities are needed; App Sandbox is set by the entitlements.
2. **Certificates:** on the Mac, create an **Apple Distribution** certificate
   and a **Mac Installer Distribution** certificate (Keychain Access →
   Certificate Assistant → Request a Certificate from a Certificate Authority),
   download both and open them so they land in the login keychain.
3. **Profiles:** create a **Mac App Store Connect** distribution profile for
   `com.docuflex.editor` with the Apple Distribution certificate and download
   it, e.g. to `~/Documents/Docuflex_App_Store.provisionprofile`.
4. **App Store Connect:** create the macOS app record with the same bundle ID
   and SKU `docuflex`, and complete Agreements, Tax and Banking (the free app
   agreement is enough) and the EU trader status.

Each upload, from `desktop/`:

```sh
APPLE_SIGNING_IDENTITY='Apple Distribution: YOUR NAME (TEAMID)' APPLE_INSTALLER_IDENTITY='3rd Party Mac Developer Installer: YOUR NAME (TEAMID)' DOCUFLEX_PROVISIONING_PROFILE=~/Documents/Docuflex_App_Store.provisionprofile DOCUFLEX_STORE_BUILD_NUMBER=1 npm run build:appstore
```

`security find-identity -v` lists the exact identity names (the installer
certificate may be listed as "Mac Installer Distribution" or "3rd Party Mac
Developer Installer"; use the name shown). The build checks the profile, the
team and the build number before compiling, embeds the profile, adds the Team
ID entitlements to the app, signs everything and writes
`target-app-store/release/bundle/macos/Docuflex_<version>_<build>_AppStore.pkg`.
Upload that package with Transporter. Use a higher build number for every
upload, including re-uploads of the same version. The Info.plist declares
`ITSAppUsesNonExemptEncryption = false` (only standard HTTPS/TLS), so uploads
do not ask the export-compliance question. Never upload the ad-hoc QA build.

## Submission gates still requiring completion

A successful local build is not App Store approval. Before upload/review:

- Complete paid membership, account agreements, actual signing and validation.
- Audit required-reason APIs, privacy manifests and App Privacy answers against
  all bundled native dependencies and the actual feedback/cloud data flows.
- Review third-party notices and license compatibility, including AGPL-3.0-only
  project licensing and the full TeX/Office/model distributions. An MIT wrapper
  does not change bundled dependencies' licenses.
- Deploy and verify the approved public privacy/support pages through the
  normal reviewed PR/merge process. The `/privacy` route must be live; local
  source alone is insufficient.
- Finish the stable-release readiness review, screenshots, listing metadata,
  age rating, export-compliance answers and reviewer instructions. Do not
  present a beta-quality candidate as a finished public release.
- Exercise the signed sandboxed candidate's file access, save/export, printing,
  camera/signature import, OCR, Office conversion, local models and cloud AI
  consent before submission. Test sandbox behavior in the actual `.app`, not
  just unbundled command-line tools.

The direct-download build keeps its updater and existing JVM/engine behavior.
Windows/Linux/Arch release packaging remains the GitHub Actions workflow in
`RELEASING.md`; this Mac-only profile does not replace those artifacts.

## Local verification on 2026-11-02

The Apple Silicon local QA build passed deep/strict ad-hoc signature validation
(463 Mach-O files and three nested bundles) and launched inside App Sandbox
alongside the installed direct-download app. Native PDF checks passed for
fonts, text edits, pages, markup, images/alpha, Unicode, forms, encryption, OCR
and redaction. A separate pixel/OCR test verified opaque redaction and removed
secret text at all four rotations while retained text remained readable.
Bundled runtime smoke tests covered OCR, editable/Office conversion and offline
TeX compilation. Native settings showed no external Update action. Runtime
status confirmed the bundled Qwen executable stays stopped on startup and the
translation engine is local. Store model-archive rejection tests passed.

This validation used ad-hoc signing and disposable documents, not an Apple
distribution certificate or App Store processing. Qwen inference/model download
and actual local translation were not repeated in the isolated QA container.
The final distribution-signed app still needs those checks and all submission
gates above.
