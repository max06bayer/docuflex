<script>
  import { onDestroy, tick } from 'svelte';
  import { cubicOut } from 'svelte/easing';
  import { fade, fly, scale } from 'svelte/transition';

  /** @type {() => void} */
  export let onClose = () => {};
  export let legalOnly = false;
  export let legalSection = 'top';
  let legalOpen = legalOnly;
  /** @type {HTMLDivElement | undefined} */
  let legalContentElement;

  function closeLegal() {
    legalOpen = false;
    if (legalOnly) onClose();
  }

  /** @param {MouseEvent} event */
  function handleBackdropClick(event) {
    if (event.target === event.currentTarget) closeLegal();
  }

  /** @param {KeyboardEvent} event */
  function handleKeydown(event) {
    if (event.key !== 'Escape') return;
    if (legalOpen) closeLegal();
    else onClose();
  }

  if (typeof window !== 'undefined') window.addEventListener('keydown', handleKeydown);
  onDestroy(() => window.removeEventListener('keydown', handleKeydown));

  if (legalOnly && typeof window !== 'undefined') {
    tick().then(() => {
      if (!legalContentElement || legalSection === 'top') return;
      const target = legalContentElement.querySelector(`[data-legal-section="${legalSection}"]`);
      if (target instanceof HTMLElement) legalContentElement.scrollTop = Math.max(0, target.offsetTop - 24);
    });
  }
</script>

{#if !legalOnly}
  <div class="settings-panel" role="dialog" aria-label="Settings" transition:fly={{ x: 18, duration: 240, easing: cubicOut }}>
    <header class="panel-header">
      <img src="/settings.svg" alt="" />
      <h2>Settings</h2>
      <button class="panel-close" type="button" aria-label="Close Settings" onclick={onClose}><span></span><span></span></button>
    </header>

    <div class="settings-content">
      <a class="settings-row" href="https://github.com/max06bayer/docuflex" target="_blank" rel="noreferrer">
        <span>GitHub</span>
      </a>
      <a class="settings-row" href="/">
        <span>Homepage</span>
      </a>
      <button class="settings-row" type="button" onclick={() => (legalOpen = true)}>
        <span>Legal &amp; Privacy</span>
      </button>
    </div>
  </div>
{/if}

{#if legalOpen}
  <div class="legal-backdrop" role="presentation" onclick={handleBackdropClick} transition:fade={{ duration: 170 }}>
    <dialog
      open
      class="legal-panel"
      aria-modal="true"
      aria-labelledby="legal-title"
      transition:scale={{ duration: 190, easing: cubicOut, start: 0.97, opacity: 0 }}
    >
      <header class="panel-header legal-header">
        <img src="/settings.svg" alt="" />
        <h2 id="legal-title">Legal &amp; Privacy</h2>
        <button class="panel-close legal-close" type="button" aria-label="Close Legal and Privacy" onclick={closeLegal}><span></span><span></span></button>
      </header>

      <div class="legal-content" bind:this={legalContentElement}>
        <div class="legal-intro">
          <p>Docuflex is a public beta of a source-available PDF app. It is offered for personal and other non-commercial use and has no user accounts, subscriptions, advertising, or built-in analytics.</p>
          <p class="updated">Last updated: July 17, 2026</p>
        </div>

        <section data-legal-section="privacy">
          <h3>Privacy</h3>
          <p><strong>Controller.</strong> Maximilian Bayer, Lehmgrubenstraße 11, 86932 Pürgen, Germany. Email: <a href="mailto:max06.bayer@gmail.com">max06.bayer@gmail.com</a>.</p>
          <p><strong>Files you open.</strong> Recent documents are stored in your browser using IndexedDB so they can appear on the home screen. Saved signatures are stored in your browser using local storage. They remain on that browser until you delete them in Docuflex, clear the browser’s site data, or the browser removes them.</p>
          <p><strong>Hosting.</strong> Docuflex runs on infrastructure supplied by netcup GmbH at the Vienna, Austria server location. The deployment is managed with a self-hosted Coolify installation and its Traefik reverse proxy. Cloudflare is not used.</p>
          <p><strong>Document processing.</strong> When you use conversion, compression, translation, OCR, protection, flattening, text editing, or export, the document is sent to the Docuflex server serving this app. OCR and PDF conversion run locally on that server. Temporary processing files are removed after the operation and are not used for advertising, profiling, or model training.</p>
          <p><strong>Operational logs.</strong> The application does not use analytics, visitor tracking, third-party error reporting, or external log drains. Application errors and container events may appear in local Coolify and Docker console logs for troubleshooting and security. The app does not create a separate document or visitor database from these logs. Logs remain until the relevant container is replaced or removed, server cleanup runs, or longer retention is necessary to investigate a security incident.</p>
          <p><strong>No sale or advertising sharing.</strong> Docuflex does not sell personal information or share it for cross-context behavioral advertising.</p>
        </section>

        <section data-legal-section="cookies">
          <h3>Cookies</h3>
          <p><strong>Docuflex does not currently set or use cookies.</strong> The app does not use advertising cookies, analytics cookies, tracking pixels, or third-party marketing identifiers.</p>
          <p>Browser storage used for recent documents and saved signatures is not cookie storage. Recent documents use IndexedDB and saved signatures use local storage, as described in the Privacy section above. You can remove this data from Docuflex or through your browser’s site-data settings.</p>
          <p>If cookies are introduced in a future version, this notice will be updated before they are used and any consent required by applicable law will be requested.</p>
        </section>

        <section>
          <h3>Your choices and rights</h3>
          <p>You can remove recent files from the home screen, remove saved signatures in the signature tool, or clear all locally stored Docuflex data through your browser’s site-data settings.</p>
          <p>Depending on where you live, you may have rights to request access, correction, deletion, restriction, portability, or objection regarding personal data processed by the public-site operator, and to complain to your local data-protection authority. Send privacy requests to <a href="mailto:max06.bayer@gmail.com">max06.bayer@gmail.com</a>.</p>
        </section>

        <section>
          <h3>Software license</h3>
          <p>Docuflex is source-available under the <strong>PolyForm Noncommercial License 1.0.0</strong>. Personal and other non-commercial use, modification, non-commercial forks, and non-commercial redistribution are permitted. Commercial use is not permitted without a separate license from the copyright holder.</p>
          <p>The complete <code>LICENSE</code> file in the repository controls. This summary does not replace or modify it. Third-party dependencies remain governed by their own licenses.</p>
        </section>

        <section data-legal-section="terms">
          <h3>Terms of use</h3>
          <p>You must have the right to use and process any document you upload. Do not use the service to violate law, privacy, confidentiality, intellectual-property rights, or the rights of others.</p>
          <p>Docuflex is a development preview and may contain errors, alter document appearance, or produce incomplete results. Keep an original copy and independently verify important output. It is not legal, medical, financial, archival, or security advice and should not be the only system used for critical documents.</p>
          <p>To the extent allowed by applicable law, the software and service are provided “as is,” without warranties, and the project operator is not liable for losses arising from their use. Rights that cannot legally be excluded remain unaffected.</p>
        </section>

        <section class="operator-notice">
          <h3>Operator information</h3>
          <p><strong>Service provider and person responsible for Docuflex</strong><br />Maximilian Bayer<br />Lehmgrubenstraße 11<br />86932 Pürgen<br />Germany</p>
          <p>Email: <a href="mailto:max06.bayer@gmail.com">max06.bayer@gmail.com</a><br />GitHub: <a href="https://github.com/max06bayer/docuflex" target="_blank" rel="noreferrer">max06bayer/docuflex</a></p>
        </section>
      </div>

      <footer class="legal-footer"><button type="button" onclick={closeLegal}>Done</button></footer>
    </dialog>
  </div>
{/if}

<style>
  .settings-panel { position: fixed; z-index: 70; top: 70px; right: 14px; display: grid; grid-template-rows: 50px 1fr; width: min(260px, calc(100% - 28px)); height: 185px; border: 1.5px solid transparent; border-radius: 13px; background: #fafafa; box-shadow: 0 12px 32px rgba(0,0,0,.12); color: #000; font-family: "Inter Variable", Inter, sans-serif; }
  .settings-panel::after { position: absolute; z-index: 100; inset: -1.5px; border: 1.5px solid #c5c5c5; border-radius: 13px; content: ''; pointer-events: none; }
  .panel-header { display: grid; grid-template-columns: 26px 1fr 28px; align-items: center; height: 50px; padding: 0 12px; border-bottom: 1px solid #cacaca; border-radius: 12px 12px 0 0; background: #eee; }
  .panel-header > img { width: 24px; height: 24px; }
  .panel-header h2 { margin: 0 0 0 7px; font-size: 18px; font-weight: 400; line-height: 1.22; letter-spacing: -.25px; }
  .panel-close { position: relative; z-index: 2; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 9px; background: transparent; cursor: pointer; transition: transform 160ms ease; }
  .panel-close:active { transform: scale(.94); }
  .panel-close span { position: absolute; top: 13px; left: 6px; width: 16px; height: 1.5px; border-radius: 99px; background: #929292; transform: rotate(45deg); transition: background-color 160ms ease; }
  .panel-close span + span { transform: rotate(-45deg); }
  .panel-close:hover span { background: #000; }
  .settings-content { display: grid; align-content: start; gap: 0; padding: 7px; border-radius: 0 0 12px 12px; }
  .settings-row { display: flex; align-items: center; width: 100%; height: 40px; min-height: 40px; padding: 0 12px; border: 1px solid transparent; border-radius: 10px; background: transparent; color: #3f3f3f; font-family: Geist, Inter, sans-serif; font-size: 18px; text-align: left; text-decoration: none; cursor: pointer; transition: color 180ms ease, background-color 180ms ease, border-color 180ms ease, transform 180ms ease; }
  .settings-row:hover, .settings-row:focus-visible { border-color: rgba(0,0,0,.07); background: rgba(234,234,234,.62); color: #111; outline: none; transform: translateX(1px); }
  .settings-row:active { transform: translateX(1px) scale(.99); }
  .legal-backdrop { position: fixed; z-index: 2000; inset: 0; display: grid; place-items: center; padding: 24px; background: rgba(235,235,235,.6); backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px); }
  .legal-panel { position: relative; display: grid; grid-template-rows: 50px minmax(0,1fr) auto; width: min(850px, calc(100vw - 48px)); height: min(790px, calc(100dvh - 48px)); margin: 0; padding: 0; overflow: hidden; border: 1.5px solid #bdbdbd; border-radius: 13px; background: rgba(250,250,250,.97); box-shadow: 0 28px 85px rgba(0,0,0,.2), 0 5px 20px rgba(0,0,0,.1); color: #111; }
  .legal-header { min-height: 50px; padding: 0 12px; border-radius: 12px 12px 0 0; }
  .legal-content { overflow: auto; padding: 25px 30px 34px; overscroll-behavior: contain; }
  .legal-intro { max-width: 760px; margin: 0 auto 25px; padding: 18px 20px; border: 1px solid #d7d7d7; border-radius: 12px; background: #f1f1f1; }
  .legal-intro p { margin: 0; font-size: 17px; line-height: 1.45; }
  .legal-intro .updated { margin-top: 8px; color: #777; font-size: 13px; }
  .legal-content section { max-width: 760px; margin: 0 auto 27px; }
  .legal-content h3 { margin: 0 0 10px; font-size: 21px; font-weight: 520; line-height: 1.2; letter-spacing: -.3px; }
  .legal-content p { margin: 0 0 11px; color: #4e4e4e; font-size: 16px; line-height: 1.52; }
  .legal-content strong { color: #151515; font-weight: 560; }
  .legal-content code { padding: 1px 5px; border-radius: 5px; background: #e8e8e8; color: #222; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; }
  .legal-content a { color: #0878f9; text-decoration: none; }
  .legal-content a:hover { text-decoration: underline; }
  .operator-notice { padding: 18px 20px; border: 1px solid #d4d4d4; border-radius: 12px; background: #f2f2f2; }
  .operator-notice p:last-child { margin-bottom: 0; }
  .legal-footer { display: flex; justify-content: flex-end; padding: 14px 22px; border-top: 1px solid #cecece; background: #f4f4f4; }
  .legal-footer button { min-width: 120px; height: 42px; padding: 0 20px; border: 0; border-radius: 9px; background: #0878f9; color: #fff; font: inherit; font-size: 17px; cursor: pointer; box-shadow: 0 5px 15px rgba(8,120,249,.2); }
  .legal-footer button:hover { background: #006ff0; }
  @media (max-width: 680px) {
    .legal-backdrop { padding: 10px; }
    .legal-panel { width: calc(100vw - 20px); height: calc(100dvh - 20px); border-radius: 13px; }
    .legal-content { padding: 18px 18px 28px; }
    .legal-intro { padding: 15px; }
  }
</style>
