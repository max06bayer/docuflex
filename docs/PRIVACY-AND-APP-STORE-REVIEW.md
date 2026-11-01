# Privacy and Mac App Store release review

Reviewed November 1, 2026. This is an implementation audit and a list of remaining decisions, not legal approval or an App Store approval guarantee. The policy text and disclaimer need qualified German/EU legal review before relying on them to limit personal liability.

## Implemented

- One shared notice in `src/lib/LegalContent.svelte`, displayed by Settings/homepage and at `/privacy`. The public URL becomes available only after website deployment; these local changes do not deploy it.
- Operator is Maximilian Bayer, an individual running a free, personal, non-commercial project. Address corrected to Nürnberger Straße 40, 85055 Ingolstadt, Germany. No company, registration number or VAT number invented. AGPL commercial-use freedoms preserved.
- Desktop-local processing is distinguished from server-assisted website processing and optional cloud inference. Cloud requests disclose prompts, relevant history/notes, text, attachments/images and tool results, OpenRouter and inference-provider routing/fallback, potential non-EEA processing and variable retention/training policies. No universal local-only, no-training, EU-only or zero-retention promise.
- Local device storage, saved chats/notes/key, models and downloads, feedback, hosting, infrastructure logs, cookies and website measurement are described separately.
- Versioned cloud-AI permission is shared by Chat (including retry), PDF Enhance and AI Translate; accepted permission survives relaunch, and Settings can revoke it. Changing the disclosure version requires another choice. The LaTeX client pipeline also checks before reading/uploading pages. Local Qwen bypasses it. Declining preserves the chat draft. Key validation alone is not an AI-content request. External MCP clients must independently obtain their users' authorisation.
- Website analytics event cleanup added: startup of the measurement writer and hourly thereafter remove dated event files older than 90 days. Only matching event files are removed; secrets/unrelated files are preserved. Existing feedback receiver already runs hourly 90-day cleanup. File-day granularity and offline time mean these are approximate periods; backups have separate rules.
- Beta, backup/output verification, AI errors, signature/redaction limits and legally bounded warranty/liability provisions replace the former blanket disclaimer. Intent/gross negligence, personal injury, mandatory consumer/data-protection/product-liability rights and other non-excludable liability remain intact.

## Hosting agreement supplied by the operator

The supplied netcup AVV identifies netcup as processor and contains an annex expressly covering Docuflex, uploaded document content, temporary working files, access/error/security records and people named in uploaded documents. Its hosting subprocessors include Anexia entities. It does not cover OpenRouter/model-provider processing.

The customer's old address is still printed in that document. Update the netcup customer details and obtain an updated record/confirmation. The rendered signature page contains netcup's dated signature/stamp and a blank customer signature area. Confirm the portal's electronic acceptance/conclusion record rather than inferring either invalidity or completed acceptance from that blank area alone. Do not commit or publish the AVV, customer number or signature image.

The agreement's backup-deletion clause relates to the processor's return/deletion obligations after services end; it is not proof that live Docuflex application logs/backups rotate on that schedule.

## Must resolve before describing the privacy setup as verified

1. The operator confirmed Vienna, Austria as the server location on November 1, 2026; the notice now records it. Verify the processing instructions, executed AVV status and current subprocessor list against the hosting account.
2. Inspect live Coolify/Docker/Traefik access/error logs and backups. Set and document purpose-based retention, permissions, rotation and deletion. The notice currently describes configuration-dependent retention instead of inventing a number; replace it with confirmed periods or precise criteria before final legal sign-off.
3. Deploy and verify the new analytics cleanup and feedback cleanup against production. No production deletion or deployment was performed in this change. Establish whether backup copies contain these records and when those expire.
4. Document a legitimate-interest assessment for website measurement, and review GDPR/ePrivacy/TDDDG requirements for daily hashed visitors. Cookie-free does not by itself establish a consent exemption or anonymity. Stop/disable optional measurement if a lawful basis cannot be supported.
5. Review special-category/criminal-record data and professional/confidential documents. A hosting AVV does not itself establish an Article 9/10 basis or lawful international transfers. Third-party document subjects do not automatically consent because a user clicks the cloud prompt. Determine controller/processor roles, necessary Art. 28 agreements and Chapter V safeguards for actual provider endpoints. If these cannot be supported, constrain routing/data categories or remove the affected processing; disclosure alone does not cure it.
6. Maintain an Article 30 processing inventory, access/deletion and breach-response procedures as applicable. Review email handling/retention for replies to feedback separately from the receiver's 90-day files.
7. Have qualified counsel review the legal basis, private-project provider disclosure obligations, liability wording and applicability of consumer/product rules. Free/open-source/non-commercial status does not remove all duties or liability.

## Mac App Store blockers in the current distribution architecture

Do not describe the present DMG build as App Store ready. The sandbox follow-up below changes packaging and local file access, but does not resolve the remaining store-distribution requirements.

- **Beta distribution:** Apple guideline 2.2 directs beta builds to TestFlight. A beta warning cannot convert a beta into a store-ready finished product.
- **Sandbox/container:** App Sandbox is now enabled. Services inherit the sandbox, data/cache/temp paths use the app container, and native document access uses user selection and saved security-scoped bookmarks. Installed Node/Java/Office/OCR and local Qwen checks passed; broader camera, printing, recovery and file-lifecycle QA remains required (2.4.5(i)-(iii)).
- **Updates:** Settings invokes Docuflex's own GitHub/native updater. Store builds must use App Store updates; disable/remove this path in that distribution (2.4.5(vii)).
- **Downloadable code:** Windows/Linux Qwen now downloads executable runtime libraries, and local translation installation can fetch runtime packages. macOS Qwen's inference runtime is bundled, with model data downloaded later. Audit every Mac download path for executable code, and prebundle required runtime/helpers for the store build. Distinguish weights/data from executable runtime code; get Apple's review of any optional downloaded resources (2.4.5(iv), 2.5.2).
- **Java/helper technologies:** guideline 2.4.5(viii) names Java among deprecated/optionally installed technologies. The current backend bundles Java. Resolve this architecture/review risk with Apple; merely bundling Java or adding a disclaimer is not an approval guarantee.
- **Privacy:** keep `/privacy` publicly reachable and link it in App Store Connect and in-app. Review App Privacy answers for actual feedback/cloud-provider practices, purpose strings and required-reason APIs/privacy manifests for all shipped dependencies. Do not tick “Data Not Collected” without mapping each flow to Apple's definitions. New explicit AI permission helps address 5.1.2(i) but does not prove provider safeguards or lawful transfers.
- **Licenses:** audit AGPL-3.0-only code and every bundled dependency/model against store terms and source/redistribution duties. Do not silently relicense the project or assume ownership of all third-party code. GPL/App Store distribution restrictions have a documented history of conflict; obtain a current license assessment rather than assuming a blanket prohibition or compatibility.
- **Signing/review:** current Tauri config uses ad-hoc signing (`-`). Store distribution requires appropriate Apple membership, signing/provisioning, packaging and submission, plus complete functionality review. No store submission, account change, publication or release promotion is part of this change.

## Primary references checked

- Apple review requirements 2.2, 2.4.5, 2.5.2 and 5.1: https://developer.apple.com/app-store/review/guidelines/
- Apple privacy declarations: https://developer.apple.com/app-store/app-privacy-details/
- GDPR: https://eur-lex.europa.eu/eli/reg/2016/679/oj
- German limits on standard-form liability exclusions: https://www.gesetze-im-internet.de/bgb/__309.html
- Provider information duties: https://www.gesetze-im-internet.de/ddg/__5.html
- OpenRouter privacy: https://openrouter.ai/privacy
- OpenRouter provider-specific data handling: https://openrouter.ai/docs/guides/privacy/provider-logging
- netcup AVV guidance: https://www.netcup.com/de/helpcenter/dokumentation/general/avv
- Historical licensing issue (not a current definitive compatibility assessment): https://www.fsf.org/blogs/licensing/more-about-the-app-store-gpl-enforcement

## Broader store criteria

The original follow-up was read-only. After that audit, the operator explicitly requested the sandbox implementation. Rows below reflect the installed sandbox follow-up where tested; no Apple account change, website deployment, store submission or release publication was performed.

| Area | Current finding | Status |
| --- | --- | --- |
| Actual installed signing | `/Applications/Docuflex.app` reports `Signature=adhoc` and `TeamIdentifier=not set`; configured identity is also `-`. | Confirmed submission blocker |
| Actual installed sandbox | App Sandbox, selected-file read/write, app-scoped bookmarks, client/server networking, camera and print entitlements are present. External arbitrary file access is denied; parent and inference/helper processes were observed sandboxed. | Implemented; full lifecycle and target-device QA pending |
| Store build/update path | DMG distribution retains the native GitHub updater. On macOS it saves and opens a verified installer through a native user-selected destination, rather than trying to replace the app from inside the sandbox. The installed update check succeeds using system curl. | Dedicated App Store update path still required |
| Beta completeness | Legal text identifies experimental beta; no clean-install, full-feature store acceptance run was completed in this audit. | Not ready for a finished store submission |
| Runtime installation | Translation `runDownload` resolves/installs engine wheels if absent. Native services include Java, Node, Python and office/OCR binaries. | Store-code-download and helper architecture review required |
| Public privacy URL | `HEAD https://docuflex.eu/privacy` returned 404 on November 1. Local `/privacy` renders successfully. | New page not deployed; final store URL not yet ready |
| Cloud disclosure | Local UI verified: decline and Escape return false; acceptance is shared; reloading preserves acceptance; revocation makes the prompt return. Chat send/retry and the shared Enhance/AI Translate pipeline are gated. | Installed in desktop build; website not deployed |
| Camera | `NSCameraUsageDescription` clearly describes photographing a chosen signature; camera entitlement exists. Actual OS allow/deny and sandbox behavior were not tested here. | Purpose text present; interaction verification pending |
| Privacy manifests | No `PrivacyInfo.xcprivacy` or embedded provisioning profile found in the inspected app/resources. Inventory required-reason API use and applicable SDK requirements; absence alone is not proof that every API requires a manifest. | Audit incomplete; do not claim compliance |
| AI-content safeguards | Targeted source search found no explicit objectionable-content moderation/reporting workflow for model output. Ordinary feedback/contact exists, but that alone does not establish an AI-safety workflow. Local Qwen and variable cloud endpoints cannot be presumed to provide consistent moderation. | Review risk under guideline 1.2, which expressly includes AI creation apps |
| Encryption/export | The editor offers PDF password protection/encryption in addition to HTTPS. Export-compliance answers/documentation and territorial requirements are not verified. Do not declare “no encryption” just because TLS is standard. | App Store Connect determination required |
| External paid models | The app is free and has no Docuflex subscription, but a user-supplied key can invoke paid OpenRouter services. This is not necessarily a software license key; review notes must explain the optional third-party service and assess payment/links rules. | Apple business-model review risk, not an assumed rejection |
| App account deletion / Sign in with Apple / IAP | No Docuflex accounts, social sign-in, subscriptions or purchases found in the reviewed flows. OpenRouter credentials belong to a separate service. | Account-deletion/social-login rules appear inapplicable to present Docuflex accounts; reassess if added |
| Individual developer / EU trader status | A company is not inherently required. Actual Apple enrollment, legal name, age/authority, agreements and DSA trader/non-trader declaration were not inspected. A free hobby project can be non-trader; absence of a company is not a complete legal test. | Account-holder confirmation required |
| Metadata and review access | App name/category/description, screenshots, support URL, age questionnaire, content rights, app icon, review notes, demo access to cloud features and complete backend availability are not verified in App Store Connect. Reviewer must be able to test features without buying an unrelated service. | Submission checklist pending |
| Minimum OS / architecture | Installed app is Apple Silicon arm64; configured minimum macOS is 26.0. This is not by itself a rejection. Test the declared minimum and currently shipping macOS, and describe compatibility accurately. | Hardware/OS testing pending |
| File access / lifecycle | Source uses native file destinations and explicit service-stop handlers. Sandbox security-scoped access, reopen/recovery, printing, drop behavior, offline operation, model download cancellation and absence of orphan helpers need store-build testing. | Source mechanisms present, store behavior unverified |
| Design / accessibility | Legal/disclosure components were visually checked in light/dark themes. This is not a full-app VoiceOver, keyboard, contrast, resize, reduced-motion or accessibility-label audit. | Full-app QA pending; claim only tested accessibility features |
| Licenses / trademarks | AGPL source, dependency and model licenses need distribution review. A custom local-model mark is used; provider logos and other distributed assets still require rights/attribution verification. | Legal/distribution assessment pending |
| Security and data integrity | Existing request-origin checks, temporary-file cleanup and backup warnings help, but no full penetration, parser, malicious-document or data-loss audit was performed. | No universal safety certification |
| Unrelated regulated categories | No gambling, financial trading, health-service, VPN, public social network, advertising or children-targeted service identified in this review. User PDFs may nevertheless contain sensitive data. | Reassess if product scope changes |

Additional primary references:

- Sandbox documentation: https://developer.apple.com/documentation/security/app-sandbox
- Encryption/export declaration: https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance
- Age questionnaire: https://developer.apple.com/help/app-store-connect/manage-app-information/set-an-app-age-rating/
- Privacy policy URL/declarations: https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy/
- EU trader assessment (including hobby developers): https://developer.apple.com/help/app-store-connect/manage-compliance-information/manage-european-union-digital-services-act-trader-requirements/

The remaining signing and store-update blockers alone prevent an honest “all criteria met” conclusion. Apple review, account metadata, legal enforceability, production configuration and target-device behavior cannot be certified from this source inspection.

## Sandbox follow-up validation — November 1, 2026

- Installed `/Applications/Docuflex.app` has the correct name, bundle identifier and version 0.9.6. Its deep/strict code-signature verification passes, but signing remains ad-hoc with no Team ID; no valid Apple signing identity was available.
- Bundled Mach-O executables inherit App Sandbox. Signing restores framework symlinks and uses interpreter-specific JIT/library entitlements instead of retaining vendor debugger permissions. No whole-home or arbitrary-file sandbox exceptions were added.
- Services use Foundation-derived container home/temp paths and explicit local data/cache directories. Optional native folder import preserves existing files and refuses links/special files. Models, chats and credentials from the previous local test installation were retained on this Mac.
- Installed packaged Word/PowerPoint/Excel roundtrips, editable text and OCR passed. Python MIME setup avoids restricted system configuration; LibreOffice IPC uses a private working directory and relative socket path.
- Tectonic was separately verified in an actually sandboxed helper (sandbox check returned 1), including a cold package download and a successful math PDF compilation.
- Local Qwen ran in the sandbox with GPU acceleration; its reported model-memory allocation was entirely in GPU memory. Broader hardware validation remains pending.
- The installed Update action now reaches GitHub and reports 0.9.6 as up to date. macOS explicitly uses `/usr/bin/curl`, avoiding sandbox-denied third-party executables found through PATH. This validates the check; a real newer-release download/install was not exercised.
- Cloud disclosure now mounts inside the editor shell to inherit the existing popup scale. The optional migration helper sentence was removed at the operator's request.
- Svelte diagnostics: zero errors/warnings. Rust check and release compilation passed. The targeted Node test set passed all 58 tests.

This follow-up establishes the tested sandbox mechanisms, not universal App Store compliance or approval. Camera/printing, durable external-document reopen/save across relaunch, model-download cancellation and a clean install on another Mac still need end-to-end validation.
