<script>
  import { onDestroy } from 'svelte';
  import { cubicOut } from 'svelte/easing';
  import { fly } from 'svelte/transition';

  /** @type {() => void} */
  export let onClose = () => {};
  /** @type {HTMLInputElement | undefined} */
  let fileInput;
  /** @type {File | null} */
  let inputFile = null;
  let password = '';
  let confirmPassword = '';
  let showPassword = false;
  let showConfirmPassword = false;
  let error = '';
  let protecting = false;

  function chooseFile() {
    fileInput?.click();
  }

  /** @param {Event} event */
  function handleFile(event) {
    const input = /** @type {HTMLInputElement} */ (event.currentTarget);
    const file = input.files?.[0] ?? null;
    input.value = '';
    if (!file) return;
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      error = 'Choose a PDF file.';
      return;
    }
    inputFile = file;
    error = '';
  }

  async function submitProtection() {
    error = '';
    if (!inputFile) error = 'Upload a PDF file.';
    else if (!password) error = 'Enter a password.';
    else if (new TextEncoder().encode(password).length > 32) error = 'Password must be 32 bytes or fewer.';
    else if (password !== confirmPassword) error = 'Passwords do not match.';
    else {
      protecting = true;
      try {
        const response = await fetch('/api/pdf/export', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pdfBase64: arrayBufferToBase64(await inputFile.arrayBuffer()),
            annotations: [],
            encryptionPassword: password
          })
        });
        if (!response.ok) {
          const result = await response.json().catch(() => null);
          throw new Error(result?.error ?? `PDF protection failed (${response.status}).`);
        }
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `${inputFile.name.replace(/\.pdf$/i, '') || 'document'}-protected.pdf`;
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        onClose();
      } catch (protectionFailure) {
        console.error(protectionFailure);
        error = protectionFailure instanceof Error ? protectionFailure.message : 'Could not protect this PDF.';
      } finally {
        protecting = false;
      }
    }
  }

  /** @param {ArrayBuffer} buffer */
  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
  }

  /** @param {KeyboardEvent} event */
  function handleKeydown(event) {
    if (event.key === 'Escape') onClose();
  }

  if (typeof window !== 'undefined') window.addEventListener('keydown', handleKeydown);
  onDestroy(() => window.removeEventListener('keydown', handleKeydown));
</script>

<div class:has-error={Boolean(error)} class="protect-panel" role="dialog" aria-label="Password Protect" transition:fly={{ x: 18, duration: 240, easing: cubicOut }}>
  <header class="panel-header">
    <img src="/lock.svg" alt="" />
    <h2>Password Protect</h2>
    <button class="panel-close" type="button" aria-label="Close password protection" onclick={onClose}><span></span><span></span></button>
  </header>
  <form class="protect-form" onsubmit={(event) => { event.preventDefault(); submitProtection(); }}>
    <div class="upload-section">
      <button class="upload-file" type="button" onclick={chooseFile}>
        {#if !inputFile}<span class="action-plus" aria-hidden="true"></span>{/if}
        <span>{inputFile ? inputFile.name : 'Upload File'}</span>
      </button>
    </div>
    <div class="protect-fields">
      <div class="password-fields-enter">
        <div class:error={error === 'Enter a password.' || error === 'Password must be 32 bytes or fewer.'} class="password-field">
          <input type={showPassword ? 'text' : 'password'} placeholder="Password" aria-label="Password" autocomplete="new-password" bind:value={password} oninput={() => error = ''} />
          <button class="password-visibility" type="button" aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword} onclick={() => showPassword = !showPassword}>
            <img class:visible={!showPassword} src="/eye.svg" alt="" /><img class:visible={showPassword} src="/eye-off.svg" alt="" />
          </button>
        </div>
        <div class:error={error === 'Passwords do not match.'} class="password-field">
          <input type={showConfirmPassword ? 'text' : 'password'} placeholder="Confirm Password" aria-label="Confirm password" autocomplete="new-password" bind:value={confirmPassword} oninput={() => error = ''} />
          <button class="password-visibility" type="button" aria-label={showConfirmPassword ? 'Hide confirmed password' : 'Show confirmed password'} aria-pressed={showConfirmPassword} onclick={() => showConfirmPassword = !showConfirmPassword}>
            <img class:visible={!showConfirmPassword} src="/eye.svg" alt="" /><img class:visible={showConfirmPassword} src="/eye-off.svg" alt="" />
          </button>
        </div>
      </div>
      <p class:visible={Boolean(error)} class="protection-error" aria-live="polite">{error}</p>
    </div>
    <div class="protect-warning"><h3>Warning:</h3><p>Full <span>AES-256 Encryption.</span> If you lose the Password, the file can NOT be restored.</p></div>
    <footer class="protect-actions"><button class="protect-submit" type="submit" disabled={protecting}><img src="/lock.svg" alt="" /><span>{protecting ? 'Protecting…' : 'Enable Encryption'}</span></button></footer>
  </form>
  <input bind:this={fileInput} class="file-input" type="file" accept="application/pdf,.pdf" onchange={handleFile} />
</div>

<style>
  /* Matches the redesign panels (TranslateFilesPanel, SettingsPanel, PdfEditor .protect-panel). */
  .protect-panel { position: absolute; z-index: 45; top: 12px; left: 13px; display: grid; box-sizing: border-box; width: min(320px, calc(100% - 26px)); border: 1.5px solid #c3c2c2; border-radius: 21px; background: rgba(240, 236, 236, 0.75); box-shadow: 0 4px 20px rgba(0, 0, 0, 0.05); backdrop-filter: blur(1.3px); -webkit-backdrop-filter: blur(1.3px); color: #000; font-family: "Geist Variable", Geist, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 19px; letter-spacing: -0.19px; -webkit-font-smoothing: antialiased; grid-template-rows: 50px 1fr; height: 480px; max-height: calc(100% - 24px); overflow: hidden; transition: height 300ms cubic-bezier(0.22, 1, 0.36, 1); }
  .panel-header { display: grid; grid-template-columns: 24px 1fr 28px; align-items: center; box-sizing: border-box; height: 50px; padding: 0 14px 0 15px; border-bottom: 1.5px solid #c3c2c2; border-radius: 19.5px 19.5px 0 0; background: rgba(214, 214, 214, 0.75); }
  .panel-header > img { width: 24px; height: 24px; object-fit: contain; }
  .panel-header h2 { margin: 0 0 0 8px; overflow: hidden; font-size: 20px; font-weight: 400; line-height: 1.22; letter-spacing: -0.2px; text-overflow: ellipsis; white-space: nowrap; }
  .panel-close { width: 28px; height: 28px; padding: 0; border: 0; border-radius: 9px; background: url('/redesign/panel-close.svg') center / 12.67px 12.67px no-repeat; cursor: pointer; transition: transform 160ms ease, filter 160ms ease; }
  .panel-close span { display: none; }
  .panel-close:hover { filter: brightness(0); }
  .panel-close:active { transform: scale(0.94); }
  .protect-panel.has-error { height: 516px; }
  .protect-form { display: grid; grid-template-rows: 78px 130px 140px 78px; min-height: 0; }
  .protect-panel.has-error .protect-form { grid-template-rows: 78px 166px 140px 78px; }
  .upload-section { display: grid; align-content: center; padding: 15px 11px 15px 12px; border-bottom: 1px solid rgba(0, 0, 0, 0.1); }
  .upload-file { display: flex; align-items: center; justify-content: center; gap: 8px; box-sizing: border-box; min-width: 0; height: 48px; padding: 0 13px; border: 1px solid rgba(0, 0, 0, 0.1); border-radius: 15px; background: #fff; color: rgba(0, 0, 0, 0.5); font: inherit; letter-spacing: inherit; cursor: pointer; transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease, transform 160ms ease; }
  .upload-file:hover { border-color: rgba(0, 0, 0, 0.18); color: rgba(0, 0, 0, 0.75); }
  .upload-file:active { transform: scale(0.985); }
  .upload-file span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .action-plus { position: relative; flex: 0 0 auto; width: 20px; height: 20px; }
  .action-plus::before, .action-plus::after { position: absolute; top: 50%; left: 50%; width: 14px; height: 1.5px; border-radius: 99px; background: currentColor; content: ''; transform: translate(-50%, -50%); }
  .action-plus::after { transform: translate(-50%, -50%) rotate(90deg); }
  .protect-fields { position: relative; display: grid; align-content: center; box-sizing: border-box; min-height: 0; padding: 12px 11px 12px 12px; overflow: hidden; border-bottom: 1px solid rgba(0, 0, 0, 0.1); }
  .password-fields-enter { display: grid; gap: 10px; }
  .password-field { display: grid; grid-template-columns: minmax(0, 1fr) 46px; box-sizing: border-box; height: 48px; overflow: hidden; border: 1px solid rgba(0, 0, 0, 0.1); border-radius: 15px; background: #fff; transition: border-color 150ms ease; }
  .password-field:focus-within { border-color: rgba(0, 0, 0, 0.18); }
  .password-field.error { border-color: rgba(222, 53, 66, 0.6); }
  .password-field input { min-width: 0; height: 100%; padding: 0 13px; border: 0; outline: 0; background: transparent; color: rgba(0, 0, 0, 0.75); font: inherit; letter-spacing: inherit; }
  .password-field input::placeholder { color: rgba(0, 0, 0, 0.5); opacity: 1; }
  .password-visibility { position: relative; display: grid; place-items: center; width: 46px; height: 100%; padding: 0; border: 0; background: transparent; cursor: pointer; }
  .password-visibility img { position: absolute; top: 50%; left: 50%; width: 24px; height: 24px; opacity: 0; transform: translate(-50%, -50%) scale(0.9); transition: opacity 170ms ease, transform 190ms ease; }
  .password-visibility img.visible { opacity: 0.75; transform: translate(-50%, -50%) scale(1); }
  .protection-error { width: 100%; max-height: 0; margin: 0; overflow: hidden; color: #de3542; font-size: 17px; line-height: 1.1; opacity: 0; transition: max-height 240ms ease, margin-top 240ms ease, opacity 170ms ease; }
  .protection-error.visible { max-height: 24px; margin-top: 8px; opacity: 1; }
  .protect-warning { padding: 16px 14px 10px; overflow: hidden; border-bottom: 1px solid rgba(0, 0, 0, 0.1); }
  .protect-warning h3 { margin: 0 0 7px; font-size: 20px; font-weight: 400; line-height: 1; letter-spacing: -0.2px; }
  .protect-warning p { margin: 0; color: rgba(0, 0, 0, 0.5); font-size: 18px; line-height: 1.42; letter-spacing: -0.18px; }
  .protect-warning p span { color: #0073ff; }
  .protect-actions { display: grid; align-content: center; padding: 15px 11px 15px 12px; }
  .protect-submit { display: flex; align-items: center; justify-content: center; gap: 10px; box-sizing: border-box; width: 100%; min-width: 0; height: 48px; padding: 0 17px; border: 1px solid #111; border-radius: 15px; background: #111; color: #fff; font: inherit; letter-spacing: inherit; cursor: pointer; transition: opacity 150ms ease, background-color 150ms ease, transform 160ms ease; }
  .protect-submit:active { transform: scale(0.97); }
  .protect-submit img { width: 24px; height: 24px; filter: brightness(0) invert(1); }
  .protect-submit:disabled { cursor: wait; opacity: 0.8; }
  .file-input { display: none; }

  /* dark theme: generated by scripts/generate-dark-theme.mjs — do not edit */
  :global(:root[data-theme="dark"]) .protect-panel { border: 1.5px solid #2c2c2c; background: rgba(22, 22, 22, 0.96); box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15); color: rgba(255, 255, 255, 0.92); }
  :global(:root[data-theme="dark"]) .panel-header { border-bottom: 1.5px solid #2c2c2c; background: rgba(0, 0, 0, 0.45); }
  :global(:root[data-theme="dark"]) .panel-close { filter: brightness(0) invert(1) opacity(0.78); }
  :global(:root[data-theme="dark"]) .panel-close:hover { filter: brightness(0) invert(1); }
  :global(:root[data-theme="dark"]) .upload-section { border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
  :global(:root[data-theme="dark"]) .upload-file { border: 1px solid rgba(255, 255, 255, 0.08); background: rgba(255, 255, 255, 0.05); color: rgba(255, 255, 255, 0.5); }
  :global(:root[data-theme="dark"]) .upload-file:hover { border-color: rgba(255, 255, 255, 0.144); color: rgba(255, 255, 255, 0.75); }
  :global(:root[data-theme="dark"]) .protect-fields { border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
  :global(:root[data-theme="dark"]) .password-field { border: 1px solid rgba(255, 255, 255, 0.08); background: rgba(255, 255, 255, 0.05); }
  :global(:root[data-theme="dark"]) .password-field:focus-within { border-color: rgba(255, 255, 255, 0.144); }
  :global(:root[data-theme="dark"]) .password-field.error { border-color: rgba(222, 53, 66, 0.6); }
  :global(:root[data-theme="dark"]) .password-field input { color: rgba(255, 255, 255, 0.75); }
  :global(:root[data-theme="dark"]) .password-field input::placeholder { color: rgba(255, 255, 255, 0.5); }
  :global(:root[data-theme="dark"]) .protection-error { color: #de3542; }
  :global(:root[data-theme="dark"]) .protect-warning { border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
  :global(:root[data-theme="dark"]) .protect-warning p { color: rgba(255, 255, 255, 0.5); }
  :global(:root[data-theme="dark"]) .protect-warning p span { color: #0073ff; }
  :global(:root[data-theme="dark"]) .protect-submit { border: 1px solid #ececec; background: #ececec; color: #111111; }
  :global(:root[data-theme="dark"]) .protect-submit img { filter: brightness(0); }
  /* dark theme: end generated */

</style>
