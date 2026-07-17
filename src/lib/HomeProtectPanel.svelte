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
  .protect-panel { position: absolute; z-index: 45; top: 20px; left: 14px; display: grid; grid-template-rows: 50px 1fr; box-sizing: border-box; width: min(320px, calc(100% - 28px)); height: 472px; max-height: calc(100% - 40px); overflow: hidden; border: 1.5px solid #c5c5c5; border-radius: 13px; background: #fafafa; box-shadow: 0 9px 24px rgba(0,0,0,.07); color: #000; font-family: "Inter Variable", Inter, sans-serif; font-size: 16px; transition: height 300ms cubic-bezier(.22,1,.36,1); }
  .protect-panel.has-error { height: 508px; }
  .panel-header { display: grid; grid-template-columns: 26px 1fr 28px; align-items: center; box-sizing: border-box; height: 50px; padding: 0 12px; border-bottom: 1px solid #cacaca; background: #eee; }
  .panel-header > img { width: 24px; height: 24px; }
  .panel-header h2 { margin: 0 0 0 7px; font-size: 18px; font-weight: 400; line-height: 1.22; letter-spacing: -.25px; }
  .panel-close { position: relative; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 9px; background: transparent; cursor: pointer; transition: transform 160ms ease; }
  .panel-close:active { transform: scale(.94); }
  .panel-close span { position: absolute; top: 13px; left: 6px; width: 16px; height: 1.5px; border-radius: 99px; background: #929292; transform: rotate(45deg); }
  .panel-close span + span { transform: rotate(-45deg); }
  .panel-close:hover span { background: #000; }
  .protect-form { display: grid; grid-template-rows: 78px 124px 140px 78px; min-height: 0; }
  .protect-panel.has-error .protect-form { grid-template-rows: 78px 160px 140px 78px; }
  .upload-section { display: grid; align-content: center; padding: 17px 18px; border-bottom: 1px solid #cacaca; }
  .upload-file { display: flex; align-items: center; justify-content: center; gap: 7px; min-width: 0; height: 44px; padding: 0 12px; border: 1px solid #d7d7d7; border-radius: 8px; background: #f3f3f3; color: #7a7a7a; font: inherit; font-size: 18px; cursor: pointer; }
  .upload-file span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .action-plus { position: relative; flex: 0 0 auto; width: 20px; height: 20px; }
  .action-plus::before, .action-plus::after { position: absolute; top: 50%; left: 50%; width: 14px; height: 1.5px; border-radius: 99px; background: currentColor; content: ''; transform: translate(-50%,-50%); }
  .action-plus::after { transform: translate(-50%,-50%) rotate(90deg); }
  .protect-fields { position: relative; display: grid; align-content: center; box-sizing: border-box; min-height: 0; padding: 10px 18px 14px; overflow: hidden; border-bottom: 1px solid #cacaca; }
  .password-fields-enter { display: grid; gap: 10px; }
  .password-field { display: grid; grid-template-columns: minmax(0,1fr) 44px; box-sizing: border-box; height: 40px; overflow: hidden; border: 1px solid #d7d7d7; border-radius: 8px; background: #f3f3f3; }
  .password-field:focus-within { border-color: #a9a9a9; box-shadow: 0 0 0 3px rgba(0,117,255,.09); }
  .password-field.error { border-color: #e15757; box-shadow: 0 0 0 3px rgba(225,87,87,.09); }
  .password-field input { min-width: 0; height: 100%; padding: 0 11px; border: 0; outline: 0; background: transparent; color: #343434; font: inherit; font-size: 18px; }
  .password-field input::placeholder { color: #7a7a7a; opacity: 1; }
  .password-visibility { position: relative; display: grid; place-items: center; width: 44px; height: 100%; padding: 0; border: 0; border-left: 1px solid #d7d7d7; background: transparent; cursor: pointer; }
  .password-visibility img { position: absolute; top: 50%; left: 50%; width: 24px; height: 24px; opacity: 0; transform: translate(-50%,-50%) scale(.9); transition: opacity 170ms ease, transform 190ms ease; }
  .password-visibility img.visible { opacity: 1; transform: translate(-50%,-50%) scale(1); }
  .protection-error { width: 100%; max-height: 0; margin: 0; overflow: hidden; color: #c83e3e; font-size: 18px; line-height: 1; opacity: 0; transition: max-height 240ms ease, margin-top 240ms ease, opacity 170ms ease; }
  .protection-error.visible { max-height: 22px; margin-top: 6px; opacity: 1; }
  .protect-warning { padding: 18px 19px 10px; overflow: hidden; border-bottom: 1px solid #cacaca; }
  .protect-warning h3 { margin: 0 0 7px; font-size: 18px; font-weight: 400; line-height: 1; }
  .protect-warning p { margin: 0; color: #7a7a7a; font-size: 18px; line-height: 1.42; letter-spacing: -.25px; }
  .protect-warning p span { color: #0878f9; }
  .protect-actions { display: grid; place-items: center; padding: 17px 18px; }
  .protect-submit { display: flex; align-items: center; justify-content: center; gap: 7px; width: 100%; height: 44px; padding: 0 12px; border: 0; border-radius: 8px; background: #000; color: #fff; font: inherit; font-size: 18px; cursor: pointer; }
  .protect-submit img { width: 24px; height: 24px; filter: brightness(0) invert(1); }
  .protect-submit:disabled { cursor: wait; opacity: .8; }
  .file-input { display: none; }
</style>
