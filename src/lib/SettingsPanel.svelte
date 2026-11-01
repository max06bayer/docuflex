<script>
  import { cloudAiAllowed, revokeCloudAiPermission } from '#lib/cloud-ai-permission.js';
  import LegalPanel from '#lib/LegalPanel.svelte';
  import FeedbackPanel from '#lib/FeedbackPanel.svelte';
  import { onDestroy, tick } from 'svelte';
  import { cubicOut } from 'svelte/easing';
  import { fly } from 'svelte/transition';
  import { applyTheme, currentTheme } from '#lib/theme.js';
  import { removeVisitorKey, saveVisitorKey } from '#lib/ai-web.js';
  import { checkForUpdate, isDesktopApp } from '#lib/updater.js';

  /** @type {() => void} */
  export let onClose = () => {};
  export let legalOnly = false;
  export let legalSection = 'top';
  /** @type {{ available: boolean; sandboxed?: boolean; configurable?: boolean; keyHint?: string | null } | null} */
  export let aiStatus = null;
  /** Focus the key field on open (the AI button sends people here when no key is saved). */
  export let focusKey = false;
  /** @type {() => Promise<void> | void} */
  export let onAiKeyChange = () => {};
  let theme = currentTheme();
  const desktop = isDesktopApp();
  /** @param {'light' | 'dark'} next */
  function chooseTheme(next) {
    theme = next;
    applyTheme(next);
  }
  let importingLocalData = false;
  let importMessage = '';
  let importFailed = false;
  async function importLocalData() {
    if (importingLocalData) return;
    importingLocalData = true;
    importMessage = '';
    importFailed = false;
    try {
      const api = /** @type {any} */ (window).__TAURI__;
      const files = await api.core.invoke('docuflex_import_local_data');
      await onAiKeyChange();
      const { refreshQwenStatus } = await import('#lib/qwen-download.js');
      await refreshQwenStatus();
      importMessage = `Imported ${files} files. Existing data was kept.`;
    } catch (error) {
      if (String(error) !== 'cancelled') { importFailed = true; importMessage = String(error); }
    } finally { importingLocalData = false; }
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
  let feedbackOpen = false;
  /** @type {HTMLButtonElement | undefined} */
  let feedbackButton;
  function closeFeedback() { feedbackOpen = false; tick().then(() => feedbackButton?.focus()); }
  let legalOpen = legalOnly;

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
      // Website: the key stays in this browser. Desktop: saved on this computer.
      if (/** @type {any} */ (aiStatus)?.mode === 'web') await saveVisitorKey(key);
      else {
        const response = await fetch('/api/ai/key', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error ?? 'The key could not be saved.');
      }
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
      if (/** @type {any} */ (aiStatus)?.mode === 'web') removeVisitorKey();
      else await fetch('/api/ai/key', { method: 'DELETE' });
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

  /** @param {KeyboardEvent} event */
  function handleKeydown(event) {
    if (event.key !== 'Escape') return;
    if (feedbackOpen) closeFeedback();
    else if (legalOpen) closeLegal();
    else onClose();
  }

  if (typeof window !== 'undefined') window.addEventListener('keydown', handleKeydown);
  onDestroy(() => {
    if (typeof window !== 'undefined') window.removeEventListener('keydown', handleKeydown);
  });

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
      {#if desktop}
        <button class="settings-row settings-link" type="button" onclick={() => checkForUpdate({ manual: true })}>Update</button>
      {/if}
      {#if desktop && aiStatus?.sandboxed}
        <button class="settings-row settings-link" type="button" disabled={importingLocalData} onclick={importLocalData}>{importingLocalData ? 'Importing…' : 'Import Existing AI Data…'}</button>
        {#if importMessage}<p class="settings-import-note" class:failed={importFailed} role="status">{importMessage}</p>{/if}
      {/if}
      {#if $cloudAiAllowed}
        <button class="settings-row settings-link" type="button" onclick={revokeCloudAiPermission}>Revoke Cloud AI Permission</button>
      {/if}
      <button bind:this={feedbackButton} class="settings-row settings-link" type="button" onclick={() => (feedbackOpen = true)}>Feedback</button>
      <a class="settings-row settings-link" href="https://github.com/max06bayer/docuflex" target="_blank" rel="noreferrer">GitHub</a>
      <a class="settings-row settings-link" href="/">Homepage</a>
      <button class="settings-row settings-link" type="button" onclick={() => (legalOpen = true)}>Legal &amp; Privacy</button>
    </section>
  </div>
{/if}

{#if feedbackOpen}<FeedbackPanel onClose={closeFeedback} />{/if}

{#if legalOpen}
  <LegalPanel section={legalSection} onClose={closeLegal} />
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

  .settings-import-note { margin: 0 2px; font-size: 16px; line-height: 1.4; color: rgba(0, 0, 0, 0.5); }
  .settings-import-note.failed { color: #de3542; }

  .settings-error {
    margin: -2px 2px 0;
    color: #de3542;
    font-size: 16px;
    letter-spacing: -0.16px;
  }

  /* dark theme: generated by scripts/generate-dark-theme.mjs — do not edit */
  :global(:root[data-theme="dark"]) .settings-panel { border: 1.5px solid #2c2c2c; background: rgba(22, 22, 22, 0.96); box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15); color: rgba(255, 255, 255, 0.92); }
  :global(:root[data-theme="dark"]) .settings-header { border-bottom: 1.5px solid #2c2c2c; background: rgba(0, 0, 0, 0.45); }
  :global(:root[data-theme="dark"]) .settings-close { border: 0; filter: brightness(0) invert(1) opacity(0.78); background: url('/redesign/panel-close.svg') center / 12.67px 12.67px no-repeat; }
  :global(:root[data-theme="dark"]) .settings-close:hover { filter: brightness(0) invert(1); }
  :global(:root[data-theme="dark"]) .settings-section { border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
  :global(:root[data-theme="dark"]) .settings-section:last-child { border-bottom: 0; }
  :global(:root[data-theme="dark"]) .settings-row { border: 1px solid rgba(255, 255, 255, 0.08); background: rgba(255, 255, 255, 0.05); color: rgba(255, 255, 255, 0.75); text-decoration: none; }
  :global(:root[data-theme="dark"]) .settings-theme button { border: 1px solid transparent; background: transparent; color: rgba(255, 255, 255, 0.5); }
  :global(:root[data-theme="dark"]) .settings-theme button:hover:not(.active) { color: rgba(255, 255, 255, 0.75); }
  :global(:root[data-theme="dark"]) .settings-theme button.active { border-color: rgba(255, 255, 255, 0.064); background: rgba(255, 255, 255, 0.078); color: rgba(255, 255, 255, 0.92); }
  :global(:root[data-theme="dark"]) .settings-link:hover,
  :global(:root[data-theme="dark"]) .settings-link:focus-visible { background: rgba(255, 255, 255, 0.07); outline: none; }
  :global(:root[data-theme="dark"]) .settings-key-input.focused { border-color: rgba(255, 255, 255, 0.176); }
  :global(:root[data-theme="dark"]) .settings-key-input.invalid { border-color: rgba(222, 53, 66, 0.55); }
  :global(:root[data-theme="dark"]) .settings-key-input input { border: 0; outline: 0; background: transparent; color: transparent; caret-color: transparent; }
  :global(:root[data-theme="dark"]) .settings-key-input input::placeholder { color: rgba(255, 255, 255, 0.5); }
  :global(:root[data-theme="dark"]) .settings-key-input input::selection { background: transparent; }
  :global(:root[data-theme="dark"]) .settings-key-stars { filter: brightness(0) invert(1) opacity(0.78); background: url('/redesign/key-star.svg') right center / 15px 12px repeat-x; }
  :global(:root[data-theme="dark"]) .settings-key-caret { background: rgba(255, 255, 255, 0.2); }
  :global(:root[data-theme="dark"]) .settings-key-saved span { color: rgba(255, 255, 255, 0.5); }
  :global(:root[data-theme="dark"]) .settings-key-saved code { color: rgba(255, 255, 255, 0.75); }
  :global(:root[data-theme="dark"]) .settings-action { border: 1px solid #ececec; background: #ececec; color: #111111; }
  :global(:root[data-theme="dark"]) .settings-action.secondary { border-color: rgba(255, 255, 255, 0.08); background: rgba(255, 255, 255, 0.05); color: rgba(255, 255, 255, 0.75); }
  :global(:root[data-theme="dark"]) .settings-action.secondary:not(:disabled):hover { background: rgba(255, 255, 255, 0.07); }
  :global(:root[data-theme="dark"]) .settings-import-note { color: rgba(255, 255, 255, 0.5); }
  :global(:root[data-theme="dark"]) .settings-import-note.failed { color: #de3542; }
  :global(:root[data-theme="dark"]) .settings-error { color: #de3542; }
  /* dark theme: end generated */

</style>
