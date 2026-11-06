<div class="legal-intro" id="top" data-legal-section="top">
  <p>Docuflex is a free, open-source PDF editor and a personal, non-commercial project by Maximilian Bayer. It has no Docuflex accounts, subscriptions or advertising.</p>
  <p><strong>Beta software. Keep an untouched original and check every important export.</strong> Local desktop tools run on your computer. Website tools and cloud AI have different data flows, explained below.</p>
  <p class="updated">Last updated: November 1, 2026</p>
</div>

<section id="privacy" data-legal-section="privacy">
  <h3>Your documents</h3>
  <p><strong>Desktop app.</strong> Ordinary editing, conversion, compression, OCR, local translation, protection and export run in the app’s local services on your computer. Opening a file does not upload it to Docuflex. Choosing a cloud AI model sends the material needed for that task off-device.</p>
  <p><strong>Website.</strong> Viewing and some editing run in your browser. Server-assisted tools send the document and relevant options to the Docuflex server for processing. This includes conversion, compression, OCR, local translation, protection, flattening and some editing/export operations. “Local” translation on the website means local to that server, not your device.</p>
  <p>Processing uses temporary working files, with cleanup after the operation. Crashes can leave temporary files until system or operator cleanup; deletion is not guaranteed secure erasure. Docuflex does not deliberately retain submitted documents as a document library or use them to train models.</p>
</section>

<section>
  <h3>AI: local or cloud</h3>
  <p><strong>Local Qwen.</strong> After downloading its model and required runtime, inference runs on your computer. Prompts, images and document content processed by this model are not sent to OpenRouter or the Docuflex hosting server for inference. Downloads still contact external distribution services.</p>
  <p><strong>OpenRouter cloud models.</strong> Chat, AI translation and PDF Enhance can send your prompts, relevant chat history, saved AI notes, document text, attachments, page images and tool results to <a href="https://openrouter.ai/privacy" target="_blank" rel="noreferrer">OpenRouter, Inc.</a> and the inference providers it selects. A model’s developer is not necessarily the company hosting it. Routing and fallback can change the recipient, including for free models.</p>
  <p>Desktop cloud requests go from your computer to OpenRouter. On the website, requests pass through the Docuflex server; your API key is supplied for the request and is not deliberately stored there. OpenRouter receives the key for authentication. Cloud requests can be processed outside the EU/EEA, including in the United States. Retention, training use and transfer arrangements depend on OpenRouter, the selected providers and your account settings. Docuflex cannot promise zero retention, EU-only processing or no training for every endpoint. Review <a href="https://openrouter.ai/docs/guides/privacy/provider-logging" target="_blank" rel="noreferrer">provider data policies</a> before sending sensitive material.</p>
  <p>Cloud AI is optional. The app asks for permission before the first cloud task and remembers your choice on this device; you can revoke permission for future tasks in Settings. A materially changed disclosure requires a new choice. Stopping or revoking permission cannot recall requests already sent. You need your own OpenRouter key; paid models can charge your OpenRouter account. Use a local model or ordinary editing if you do not want cloud processing. Switching models does not erase data already sent to a provider.</p>
  <p><strong>AI tools and MCP.</strong> AI can read and modify open documents using editor tools. The desktop’s local MCP interface can also expose documents and editing tools to clients you connect. Those clients and their model services have their own data practices. Only connect trusted clients, check edits, and do not assume that every edit asks for confirmation.</p>
</section>

<section>
  <h3>Storage on your device</h3>
  <p>Recent documents use IndexedDB; saved signatures, preferences and website AI data use browser/webview storage. Website keys, chat history and AI notes stay in that browser until removed, cleared or evicted. Desktop chat history, AI notes, the OpenRouter key, and downloaded models/runtimes are also stored in the app’s local data, in <code>.docuflex</code> under the app’s home directory. Sandboxed macOS builds use their private app container; Windows/Linux use your regular home folder. Translation downloads use the corresponding app cache directory. These stores are not a separate encrypted vault.</p>
  <p>Remove recent files and signatures in their tools, delete saved chats, and remove your key in Settings. Clear browser site data to remove browser-held information. Desktop data and model files may survive uninstalling the app; removing the app’s local data directory also removes its saved keys, notes, chats and downloads. Save anything you need first. Removing a recent item does not delete the original file elsewhere on disk.</p>
</section>

<section>
  <h3>Hosting, feedback and connections</h3>
  <p><strong>Hosting.</strong> The website and feedback receiver are hosted on netcup GmbH infrastructure at the Vienna, Austria server location. netcup acts as a hosting processor under an Article 28 GDPR data-processing agreement, with its authorised subprocessors. Requests necessarily reveal connection information such as IP address, time, requested URL and browser/client headers to the hosting infrastructure. Transport uses HTTPS for the public service. This does not make cloud processing end-to-end encrypted.</p>
  <p><strong>Feedback.</strong> Submitting the form sends your category, message, optional email address, app version and platform to the Docuflex server. Documents and API keys are not automatically attached. Please do not paste confidential document contents, passwords or API keys. Feedback is normally removed after 90 days by the receiver’s hourly cleanup. An email is optional; it is used to reply if appropriate.</p>
  <p><strong>Downloads and updates.</strong> Checking or downloading updates, local AI runtimes/models or language models contacts services such as GitHub, Ollama’s model registry and the Argos translation package hosts and their delivery providers. They receive normal network request information and the requested download, not your document as part of the download. Their own privacy policies apply. Opening external links also contacts the destination service.</p>
  <p><strong>Operational records.</strong> Application errors and infrastructure logs can contain request metadata and diagnostic details used for security and troubleshooting. Retention follows the relevant server, proxy and backup configuration; it is separate from the feedback deletion period. Docuflex has no third-party crash-reporting SDK. No promise is made that hosting infrastructure never logs IP addresses.</p>
</section>

<section id="cookies" data-legal-section="cookies">
  <h3>Website analytics and cookies</h3>
  <p>The desktop app sends no usage analytics. The website measures page views, tool/release-download events, approximate time on page, scroll depth, referring site, language, country/region and coarse browser, device and operating-system types. Its analytics code uses an IP address and user-agent briefly to derive a daily changing visitor hash and a local country/region lookup. Raw IP addresses are not written to the analytics event files. The hash is pseudonymous, not a guarantee of anonymity.</p>
  <p>No analytics cookies, advertising identifiers or browser-stored analytics IDs are used. Do Not Track and Global Privacy Control requests are excluded. Analytics event files are normally removed after 90 days by scheduled cleanup while the service is running. Location lookup uses a server-side database from <a href="https://db-ip.com" target="_blank" rel="noreferrer">DB-IP</a> (CC BY 4.0); it does not send visitor addresses to DB-IP.</p>
  <p>Docuflex itself does not set cookies. Functional browser storage described above supports the features you choose; it can be removed in site-data settings. Docuflex does not sell personal data or share it for targeted advertising.</p>
</section>

<section>
  <h3>Purpose, legal basis and your rights</h3>
  <p>Maximilian Bayer is responsible for personal data processed in operating the public Docuflex service. Requested document processing and responding to service requests rely on Article 6(1)(b) GDPR where necessary to provide the service. Operating and protecting the service, optional general feedback and limited website measurement rely on Article 6(1)(f): the interests in maintaining, securing and improving this free project. A legal obligation, where applicable, uses Article 6(1)(c). Where processing relies on consent, Article 6(1)(a) applies and you may withdraw it for the future. Provider services have their own responsibilities and legal bases.</p>
  <p>Providing documents or feedback is optional; the relevant feature cannot work without its required input. Email is not required to send feedback. Docuflex does not use your personal data for decisions with legal or similarly significant effects under Article 22 GDPR.</p>
  <p>Subject to the applicable conditions, you may request access, correction, erasure, restriction or portability, and object to processing based on legitimate interests. Contact <a href="mailto:max06.bayer@gmail.com">max06.bayer@gmail.com</a>. You can complain to a supervisory authority, including the <a href="https://www.lda.bayern.de/" target="_blank" rel="noreferrer">Bavarian State Office for Data Protection Supervision (BayLDA)</a>. Device-only data is not accessible to the project operator; use the local deletion controls for that data. Statutory retention duties or legal claims can require limited longer retention.</p>
</section>

<section id="terms" data-legal-section="terms">
  <h3>Beta: protect your originals</h3>
  <p>Docuflex is experimental beta software. Editing, OCR, conversion, translation, AI generation, repair and export can lose or change content, formatting, fonts, forms, annotations, metadata or signatures. A successful operation does not prove that the resulting PDF is complete, correct or suitable for its intended purpose.</p>
  <p><strong>Keep a separate backup, work on copies, and inspect the exported file before replacing an original or relying on it.</strong> Check important text, calculations, page order, signatures and accessibility in a separate viewer where appropriate. AI can invent content or make incorrect tool calls. No accuracy, availability, compatibility, recovery or security outcome is guaranteed.</p>
  <p>A drawn or inserted signature is not automatically a qualified electronic signature or proof of identity. Password protection and visual covering of content do not guarantee irreversible redaction or compliance with a particular security standard. Verify that sensitive content is actually removed. You are responsible for having permission and a lawful basis to process documents and send other people’s data to services you choose.</p>
</section>

<section>
  <h3>Warranty and liability</h3>
  <p>To the extent permitted by applicable law, Docuflex is provided free of charge “as is” and “as available,” without a contractual guarantee of fitness for a particular purpose or error-free operation. You bear the ordinary risks of using beta software and should take the backup and verification precautions above. There is no commitment to provide support, updates or continuous hosting.</p>
  <p>Liability is excluded only to the extent legally permitted. This does not exclude or limit liability for intent or gross negligence, injury to life, body or health, fraudulent concealment, an expressly assumed guarantee, applicable product-liability claims, or other liability that cannot lawfully be excluded. If liability for a slightly negligent breach of an essential contractual obligation applies, it is limited, where permitted, to foreseeable damage typical of the arrangement. Mandatory consumer, data-protection and other statutory rights remain unaffected.</p>
</section>

<section>
  <h3>Open-source and third-party licenses</h3>
  <p>Docuflex is licensed under <strong>AGPL-3.0-only</strong>. You may use it privately or commercially and inspect, modify and redistribute it under that license. The project’s non-commercial status does not restrict users to non-commercial use. Network use of a modified version carries the AGPL source-offer obligations. The complete <a href="https://github.com/max06bayer/docuflex/blob/main/LICENSE" target="_blank" rel="noreferrer">license</a> controls, including its warranty and liability provisions subject to applicable law.</p>
  <p>The <a href="https://github.com/max06bayer/docuflex" target="_blank" rel="noreferrer">source code</a> is public. Bundled libraries, runtimes, fonts and downloaded models retain their own licenses and notices. A model being free to download does not remove its license conditions. No Apple endorsement, legal advice or certification of document validity is implied.</p>
</section>

<section id="operator" data-legal-section="operator">
  <h3>Project operator &amp; privacy contact</h3>
  <p>Maximilian Bayer<br />Nürnberger Straße 40<br />85055 Ingolstadt<br />Germany</p>
  <p>A personal, non-commercial project operated by an individual, not a company.</p>
  <p><a href="mailto:max06.bayer@gmail.com">max06.bayer@gmail.com</a><br /><a href="https://github.com/max06bayer/docuflex" target="_blank" rel="noreferrer">github.com/max06bayer/docuflex</a></p>
</section>

<style>
  .legal-intro, section { padding: 20px 22px; border-bottom: 1px solid rgba(0,0,0,.1); }
  h3 { margin: 0 0 10px; font-size: 20px; font-weight: 400; line-height: 1.3; letter-spacing: -.2px; }
  p { margin: 0 0 12px; color: rgba(0,0,0,.65); font-size: 18px; line-height: 1.5; letter-spacing: -.18px; overflow-wrap: anywhere; }
  p:last-child { margin-bottom: 0; }
  strong { color: #111; font-weight: 550; }
  .updated { font-size: 16px; color: rgba(0,0,0,.5); }
  a { color: #0073ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  code { font: inherit; color: inherit; }
  @media (max-width: 480px) { .legal-intro, section { padding: 16px; } }

  /* dark theme: generated by scripts/generate-dark-theme.mjs — do not edit */
  :global(:root[data-theme="dark"]) .legal-intro,
  :global(:root[data-theme="dark"]) section { border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
  :global(:root[data-theme="dark"]) p { color: rgba(255, 255, 255, 0.65); }
  :global(:root[data-theme="dark"]) strong { color: rgba(255, 255, 255, 0.859); }
  :global(:root[data-theme="dark"]) .updated { color: rgba(255, 255, 255, 0.5); }
  :global(:root[data-theme="dark"]) a { color: #0073ff; text-decoration: none; }
  :global(:root[data-theme="dark"]) a:hover { text-decoration: underline; }
  :global(:root[data-theme="dark"]) code { color: inherit; }
  /* dark theme: end generated */

  /* dark theme: manual */
  :global(:root[data-theme="dark"]) p { color: rgba(255,255,255,.7); }
  :global(:root[data-theme="dark"]) strong { color: #ececec; }
  :global(:root[data-theme="dark"]) .updated { color: rgba(255,255,255,.5); }
  :global(:root[data-theme="dark"]) .legal-intro,
  :global(:root[data-theme="dark"]) section { border-color: rgba(255,255,255,.08); }
  /* dark theme: end manual */

</style>
