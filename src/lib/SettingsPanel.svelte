<script>
  import { onDestroy, tick } from 'svelte';
  import { cubicOut } from 'svelte/easing';
  import { fade, fly, scale } from 'svelte/transition';
  import { applyTheme, currentTheme } from '$lib/theme.js';

  /** @type {() => void} */
  export let onClose = () => {};
  export let legalOnly = false;
  export let legalSection = 'top';
  /** @type {{ available: boolean; configurable?: boolean; keyHint?: string | null } | null} */
  export let aiStatus = null;
  /** Focus the key field on open (the AI button sends people here when no key is saved). */
  export let focusKey = false;
  /** @type {() => Promise<void> | void} */
  export let onAiKeyChange = () => {};
  let theme = currentTheme();
  /** @param {'light' | 'dark'} next */
  function chooseTheme(next) {
    theme = next;
    applyTheme(next);
  }
  let keyDraft = '';
  let keyBusy = false;
  /** @type {string | null} */
  let keyError = null;
  /** @type {HTMLInputElement | undefined} */
  let keyInput;
  let keyFocused = false;
  /** Width of the masked field, so the stars know when they overflow and fade on the left. */
  let keyMaskWidth = 0;
  /** Each star is drawn 15px wide (/redesign/key-star.svg). */
  const KEY_STAR_WIDTH = 15;
  $: keyStars = keyDraft.trim().length;
  $: keyOverflows = keyStars * KEY_STAR_WIDTH > keyMaskWidth - 4;
  let legalOpen = legalOnly;
  /** @type {HTMLDivElement | undefined} */
  let legalContentElement;

  function closeLegal() {
    legalOpen = false;
    if (legalOnly) onClose();
  }

  async function saveKey() {
    const key = keyDraft.trim();
    if (!key || keyBusy) return;
    keyBusy = true;
    keyError = null;
    try {
      const response = await fetch('/api/ai/key', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? 'The key could not be saved.');
      keyDraft = '';
      await onAiKeyChange();
    } catch (error) {
      keyError = error instanceof Error ? error.message : 'The key could not be saved.';
    } finally {
      keyBusy = false;
    }
  }

  async function removeKey() {
    if (keyBusy) return;
    keyBusy = true;
    keyError = null;
    try {
      await fetch('/api/ai/key', { method: 'DELETE' });
      await onAiKeyChange();
    } finally {
      keyBusy = false;
    }
  }

  /** Pasting a key saves it right away. */
  async function handleKeyPaste() {
    await tick();
    void saveKey();
  }

  $: if (focusKey && keyInput) keyInput.focus();

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
  onDestroy(() => {
    if (typeof window !== 'undefined') window.removeEventListener('keydown', handleKeydown);
  });

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
    <header class="settings-header">
      <img src="/redesign/icon-settings2.svg" alt="" />
      <h2>Settings</h2>
      <button class="settings-close" type="button" aria-label="Close Settings" onclick={onClose}></button>
    </header>

    {#if aiStatus?.configurable}
      <section class="settings-section" aria-label="AI Chat">
        {#if aiStatus.keyHint}
          <div class="settings-key-line">
            <div class="settings-row settings-key-saved">
              <span>API Key</span>
              <code>••••{aiStatus.keyHint}</code>
            </div>
            <button class="settings-action secondary" type="button" disabled={keyBusy} onclick={removeKey}>Remove</button>
          </div>
        {:else}
          <form class="settings-key-line" onsubmit={(event) => { event.preventDefault(); void saveKey(); }}>
            <div class="settings-row settings-key-input" class:invalid={keyError} class:focused={keyFocused}>
              <!-- The key is typed into a transparent input; thin stars stand in for it and fade out on the left. -->
              <input
                bind:this={keyInput}
                bind:value={keyDraft}
                type="text"
                placeholder={keyBusy ? 'Checking key…' : 'OpenRouter API Key'}
                aria-label="OpenRouter API key"
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                disabled={keyBusy}
                oninput={() => (keyError = null)}
                onpaste={handleKeyPaste}
                onfocus={() => (keyFocused = true)}
                onblur={() => (keyFocused = false)}
              />
              {#if keyStars}
                <div class="settings-key-mask" class:overflows={keyOverflows} bind:clientWidth={keyMaskWidth} aria-hidden="true">
                  <span class="settings-key-stars" style:width={`${keyStars * KEY_STAR_WIDTH}px`}></span>
                  {#if keyFocused}<span class="settings-key-caret"></span>{/if}
                </div>
              {/if}
            </div>
            <button class="settings-action" type="submit" disabled={keyBusy || !keyDraft.trim()}>Save</button>
          </form>
          {#if keyError}<p class="settings-error">{keyError}</p>{/if}
        {/if}
      </section>
    {/if}

    <section class="settings-section" aria-label="Appearance">
      <div class="settings-row settings-theme" role="radiogroup" aria-label="Appearance">
        {#each [['light', 'Light'], ['dark', 'Dark']] as [value, label]}
          <button
            class:active={theme === value}
            type="button"
            role="radio"
            aria-checked={theme === value}
            onclick={() => chooseTheme(/** @type {'light' | 'dark'} */ (value))}
          >{label}</button>
        {/each}
      </div>
    </section>
    <section class="settings-section" aria-label="About">
      <a class="settings-row settings-link" href="https://github.com/max06bayer/docuflex" target="_blank" rel="noreferrer">GitHub</a>
      <a class="settings-row settings-link" href="/">Homepage</a>
      <button class="settings-row settings-link" type="button" onclick={() => (legalOpen = true)}>Legal &amp; Privacy</button>
    </section>
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
          <p>Docuflex is a free and open-source PDF app licensed under the GNU Affero General Public License version 3. It has no user accounts, subscriptions, or advertising. The web editor and landing page use basic, cookie-free page analytics; the desktop app sends none.</p>
          <p class="updated">Last updated: July 26, 2026</p>
        </div>

        <section data-legal-section="privacy">
          <h3>Privacy</h3>
          <p><strong>Controller.</strong> Maximilian Bayer, Lehmgrubenstraße 11, 86932 Pürgen, Germany. Email: <a href="mailto:max06.bayer@gmail.com">max06.bayer@gmail.com</a>.</p>
          <p><strong>Files you open.</strong> Recent documents are stored in your browser using IndexedDB so they can appear on the home screen. Saved signatures are stored in your browser using local storage. They remain on that browser until you delete them in Docuflex, clear the browser’s site data, or the browser removes them.</p>
          <p><strong>Hosting.</strong> Docuflex runs on infrastructure supplied by netcup GmbH at the Vienna, Austria server location. The deployment is managed with a self-hosted Coolify installation and its Traefik reverse proxy. Cloudflare is not used.</p>
          <p><strong>Document processing.</strong> When you use conversion, compression, translation, OCR, protection, flattening, text editing, or export, the document is sent to the Docuflex server serving this app. OCR and PDF conversion run locally on that server. Temporary processing files are removed after the operation and are not used for advertising, profiling, or model training.</p>
          <p><strong>Web analytics.</strong> The web editor and landing page record page views, approximate time on page, scroll depth, release downloads, and coarse device, browser, and operating-system type. IP addresses are never stored. They are used briefly in memory to derive country and region from a database on our own server, and to compute a visitor hash that changes daily. No IP address is sent to a third party. <a href="https://db-ip.com" target="_blank" rel="noreferrer">IP Geolocation by DB-IP</a> (CC BY 4.0). No cookies or browser storage are used for this. Requests with Do Not Track or Global Privacy Control are not measured. The desktop app sends no analytics.</p>
          <p><strong>Operational logs.</strong> The application does not use third-party error reporting or external log drains. Application errors and container events may appear in local Coolify and Docker console logs for troubleshooting and security. The app does not create a separate document or visitor database from these logs. Logs remain until the relevant container is replaced or removed, server cleanup runs, or longer retention is necessary to investigate a security incident.</p>
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
          <p>Docuflex is free and open-source software under the <strong>GNU Affero General Public License version 3.0 only (AGPL-3.0-only)</strong>. You may use the software for personal or commercial purposes, inspect and modify its source code, and redistribute it under the license’s terms.</p>
          <p>If you modify Docuflex and let users interact with that version over a network, the AGPL requires you to offer those users the corresponding source code. The complete <a href="https://github.com/max06bayer/docuflex/blob/main/LICENSE" target="_blank" rel="noreferrer"><code>LICENSE</code> file</a> controls; this summary does not replace or modify it. Third-party components remain governed by their own licenses.</p>
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
  /* Matches the editor's right-hand panels (PdfEditor .protect-panel). */
  .settings-panel {
    position: fixed;
    z-index: 70;
    top: 68px;
    right: 13px;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    box-sizing: border-box;
    width: min(380px, calc(100% - 26px));
    overflow: hidden;
    border: 1.5px solid #c3c2c2;
    border-radius: 21px;
    background: rgba(240, 236, 236, 0.75);
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.05);
    backdrop-filter: blur(1.3px);
    -webkit-backdrop-filter: blur(1.3px);
    color: #000;
    font-family: "Geist Variable", Geist, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 21px;
    letter-spacing: -0.21px;
    -webkit-font-smoothing: antialiased;
  }

  .settings-header {
    display: grid;
    grid-template-columns: 24px 1fr 28px;
    align-items: center;
    box-sizing: border-box;
    height: 50px;
    padding: 0 14px 0 15px;
    border-bottom: 1.5px solid #c3c2c2;
    background: rgba(214, 214, 214, 0.75);
  }

  .settings-header > img { width: 24px; height: 24px; }

  .settings-header h2 {
    margin: 0 0 0 8px;
    font-size: 20px;
    font-weight: 400;
    line-height: 1.22;
    letter-spacing: -0.2px;
  }

  .settings-close {
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 9px;
    background: url('/redesign/panel-close.svg') center / 12.67px 12.67px no-repeat;
    cursor: pointer;
    transition: transform 160ms ease, filter 160ms ease;
  }

  .settings-close:hover { filter: brightness(0); }
  .settings-close:active { transform: scale(0.94); }

  .settings-section {
    display: grid;
    gap: 10px;
    padding: 15px 11px 15px 12px;
    border-bottom: 1px solid rgba(0, 0, 0, 0.1);
  }

  .settings-section:last-child { border-bottom: 0; }

  .settings-row {
    display: grid;
    align-items: center;
    box-sizing: border-box;
    width: 100%;
    height: 48px;
    margin: 0;
    padding: 0 13px;
    border: 1px solid rgba(0, 0, 0, 0.1);
    border-radius: 15px;
    background: #fff;
    color: rgba(0, 0, 0, 0.75);
    font: inherit;
    letter-spacing: inherit;
    text-align: left;
    text-decoration: none;
    transition: background-color 150ms ease, border-color 150ms ease, transform 160ms ease;
  }

  .settings-link { cursor: pointer; }
  .settings-theme { grid-template-columns: 1fr 1fr; gap: 4px; padding: 4px; }
  .settings-theme button { height: 100%; padding: 0; border: 1px solid transparent; border-radius: 11px; background: transparent; color: rgba(0, 0, 0, 0.5); font: inherit; letter-spacing: inherit; cursor: pointer; transition: background-color 160ms ease, border-color 160ms ease, color 160ms ease, transform 160ms ease; }
  .settings-theme button:hover:not(.active) { color: rgba(0, 0, 0, 0.75); }
  .settings-theme button.active { border-color: rgba(0, 0, 0, 0.08); background: rgba(0, 0, 0, 0.06); color: #000; }
  .settings-theme button:active { transform: scale(0.97); }
  .settings-link:hover, .settings-link:focus-visible { background: rgba(255, 255, 255, 0.7); outline: none; }
  .settings-link:active { transform: scale(0.985); }

  .settings-key-line {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 10px;
    margin: 0;
  }

  .settings-key-input {
    position: relative;
    display: block;
    overflow: hidden;
  }

  .settings-key-input.focused { border-color: rgba(0, 0, 0, 0.22); }
  .settings-key-input.invalid { border-color: rgba(222, 53, 66, 0.55); }

  .settings-key-input input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    box-sizing: border-box;
    padding: 0 13px;
    border: 0;
    outline: 0;
    background: transparent;
    color: transparent;
    caret-color: transparent;
    font: inherit;
    letter-spacing: inherit;
  }

  .settings-key-input input::placeholder { color: rgba(0, 0, 0, 0.5); }
  .settings-key-input input::selection { background: transparent; }

  .settings-key-mask {
    position: absolute;
    top: 0;
    right: 13px;
    bottom: 0;
    left: 13px;
    display: flex;
    align-items: center;
    pointer-events: none;
  }

  /* Once the stars are wider than the field, the newest stay in view and the oldest fade out on the left. */
  .settings-key-mask.overflows {
    justify-content: flex-end;
    -webkit-mask-image: linear-gradient(90deg, transparent, #000 44px);
    mask-image: linear-gradient(90deg, transparent, #000 44px);
  }

  .settings-key-stars {
    flex: none;
    height: 12px;
    background: url('/redesign/key-star.svg') right center / 15px 12px repeat-x;
  }

  .settings-key-caret {
    flex: none;
    width: 1.5px;
    height: 24px;
    margin-left: 2px;
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.75);
    animation: settings-caret-blink 1.06s steps(1) infinite;
  }

  @keyframes settings-caret-blink {
    50% { opacity: 0; }
  }

  .settings-key-saved {
    grid-template-columns: auto minmax(0, 1fr);
    gap: 10px;
  }

  .settings-key-saved span { color: rgba(0, 0, 0, 0.5); }

  .settings-key-saved code {
    overflow: hidden;
    color: rgba(0, 0, 0, 0.75);
    font-family: inherit;
    text-align: right;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Same 48px height and 21px text as the rows beside it. */
  .settings-action {
    height: 48px;
    padding: 0 17px;
    border: 1px solid #111;
    border-radius: 15px;
    background: #111;
    color: #fff;
    font: inherit;
    letter-spacing: inherit;
    cursor: pointer;
    transition: opacity 150ms ease, background-color 150ms ease, transform 160ms ease;
  }

  .settings-action:active { transform: scale(0.97); }
  .settings-action:disabled { cursor: default; opacity: 0.35; }

  .settings-action.secondary {
    border-color: rgba(0, 0, 0, 0.1);
    background: #fff;
    color: rgba(0, 0, 0, 0.75);
  }

  .settings-action.secondary:not(:disabled):hover { background: rgba(255, 255, 255, 0.7); }

  .settings-error {
    margin: -2px 2px 0;
    color: #de3542;
    font-size: 16px;
    letter-spacing: -0.16px;
  }
  .panel-header { display: grid; grid-template-columns: 26px 1fr 28px; align-items: center; height: 50px; padding: 0 12px; border-bottom: 1px solid #cacaca; border-radius: 12px 12px 0 0; background: #eee; }
  .panel-header > img { width: 24px; height: 24px; }
  .panel-header h2 { margin: 0 0 0 7px; font-size: 18px; font-weight: 400; line-height: 1.22; letter-spacing: -.25px; }
  .panel-close { position: relative; z-index: 2; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 9px; background: transparent; cursor: pointer; transition: transform 160ms ease; }
  .panel-close:active { transform: scale(.94); }
  .panel-close span { position: absolute; top: 13px; left: 6px; width: 16px; height: 1.5px; border-radius: 99px; background: #929292; transform: rotate(45deg); transition: background-color 160ms ease; }
  .panel-close span + span { transform: rotate(-45deg); }
  .panel-close:hover span { background: #000; }
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

  /* dark theme: generated by scripts/generate-dark-theme.mjs — do not edit */
  :global(:root[data-theme="dark"]) .settings-panel { border: 1.5px solid #2c2c2c; background: rgba(22, 22, 22, 0.96); box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15); color: rgba(255, 255, 255, 0.92); }
  :global(:root[data-theme="dark"]) .settings-header { border-bottom: 1.5px solid #2c2c2c; background: rgba(0, 0, 0, 0.45); }
  :global(:root[data-theme="dark"]) .settings-close { filter: brightness(0) invert(1) opacity(0.78); }
  :global(:root[data-theme="dark"]) .settings-close:hover { filter: brightness(0) invert(1); }
  :global(:root[data-theme="dark"]) .settings-section { border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
  :global(:root[data-theme="dark"]) .settings-row { border: 1px solid rgba(255, 255, 255, 0.08); background: rgba(255, 255, 255, 0.05); color: rgba(255, 255, 255, 0.75); }
  :global(:root[data-theme="dark"]) .settings-theme button { color: rgba(255, 255, 255, 0.5); }
  :global(:root[data-theme="dark"]) .settings-theme button:hover:not(.active) { color: rgba(255, 255, 255, 0.75); }
  :global(:root[data-theme="dark"]) .settings-theme button.active { border-color: rgba(255, 255, 255, 0.064); background: rgba(255, 255, 255, 0.078); color: rgba(255, 255, 255, 0.92); }
  :global(:root[data-theme="dark"]) .settings-link:hover,
  :global(:root[data-theme="dark"]) .settings-link:focus-visible { background: rgba(255, 255, 255, 0.07); }
  :global(:root[data-theme="dark"]) .settings-key-input.focused { border-color: rgba(255, 255, 255, 0.176); }
  :global(:root[data-theme="dark"]) .settings-key-input.invalid { border-color: rgba(222, 53, 66, 0.55); }
  :global(:root[data-theme="dark"]) .settings-key-input input::placeholder { color: rgba(255, 255, 255, 0.5); }
  :global(:root[data-theme="dark"]) .settings-key-stars { filter: brightness(0) invert(1) opacity(0.78); }
  :global(:root[data-theme="dark"]) .settings-key-caret { background: rgba(255, 255, 255, 0.2); }
  :global(:root[data-theme="dark"]) .settings-key-saved span { color: rgba(255, 255, 255, 0.5); }
  :global(:root[data-theme="dark"]) .settings-key-saved code { color: rgba(255, 255, 255, 0.75); }
  :global(:root[data-theme="dark"]) .settings-action { border: 1px solid #ececec; background: #ececec; color: #111111; }
  :global(:root[data-theme="dark"]) .settings-action.secondary { border-color: rgba(255, 255, 255, 0.08); background: rgba(255, 255, 255, 0.05); color: rgba(255, 255, 255, 0.75); }
  :global(:root[data-theme="dark"]) .settings-action.secondary:not(:disabled):hover { background: rgba(255, 255, 255, 0.07); }
  :global(:root[data-theme="dark"]) .settings-error { color: #de3542; }
  :global(:root[data-theme="dark"]) .panel-header { border-bottom: 1px solid #292929; background: #111111; }
  :global(:root[data-theme="dark"]) .panel-close span { color: rgba(255, 255, 255, 0.5); background: rgba(255, 255, 255, 0.14); }
  :global(:root[data-theme="dark"]) .panel-close:hover span { background: #ececec; }
  :global(:root[data-theme="dark"]) .legal-backdrop { background: rgba(22, 22, 22, 0.96); }
  :global(:root[data-theme="dark"]) .legal-panel { border: 1.5px solid #2e2e2e; background: rgba(24, 24, 24, 0.95); box-shadow: 0 28px 85px rgba(0, 0, 0, 0.6), 0 5px 20px rgba(0, 0, 0, 0.3); color: rgba(255, 255, 255, 0.859); }
  :global(:root[data-theme="dark"]) .legal-intro { border: 1px solid #232323; background: #121212; }
  :global(:root[data-theme="dark"]) .legal-intro .updated { color: rgba(255, 255, 255, 0.533); }
  :global(:root[data-theme="dark"]) .legal-content p { color: rgba(255, 255, 255, 0.694); }
  :global(:root[data-theme="dark"]) .legal-content strong { color: rgba(255, 255, 255, 0.844); }
  :global(:root[data-theme="dark"]) .legal-content code { background: #101010; color: rgba(255, 255, 255, 0.867); }
  :global(:root[data-theme="dark"]) .legal-content a { color: #0878f9; }
  :global(:root[data-theme="dark"]) .operator-notice { border: 1px solid #242424; background: #121212; }
  :global(:root[data-theme="dark"]) .legal-footer { border-top: 1px solid #272727; background: #131313; }
  :global(:root[data-theme="dark"]) .legal-footer button { background: #0878f9; color: #111111; box-shadow: 0 5px 15px rgba(8, 120, 249, 0.6); }
  :global(:root[data-theme="dark"]) .legal-footer button:hover { background: #006ff0; }
  /* dark theme: end generated */

</style>
