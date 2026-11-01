<script>
  import { onMount, onDestroy } from 'svelte';
  import { cubicOut } from 'svelte/easing';
  import { fade, scale } from 'svelte/transition';
  /** @type {(allowed: boolean) => void} */
  export let onChoose = () => {};
  /** @type {HTMLDialogElement | undefined} */
  let dialog;
  /** @type {HTMLElement | null} */
  let previousFocus = null;
  onMount(() => {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.querySelector('button')?.focus();
  });
  onDestroy(() => previousFocus?.focus());
  /** @param {KeyboardEvent} event */
  function handleKeydown(event) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onChoose(false); return; }
    if (event.key !== 'Tab' || !dialog) return;
    const fields = [...dialog.querySelectorAll('button, a[href]')];
    const first = fields[0];
    const last = fields.at(-1);
    if (event.shiftKey && document.activeElement === first && last instanceof HTMLElement) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last && first instanceof HTMLElement) { event.preventDefault(); first.focus(); }
  }
</script>
<div class="disclosure-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget) onChoose(false); }} transition:fade={{ duration: 170 }}>
  <dialog open bind:this={dialog} class="disclosure-panel" aria-modal="true" aria-labelledby="disclosure-title" onkeydown={handleKeydown} transition:scale={{ duration: 190, easing: cubicOut, start: 0.97, opacity: 0 }}>
    <header class="panel-header">
      <h2 id="disclosure-title">Use Cloud AI?</h2>
      <button class="panel-close" type="button" aria-label="Close Cloud AI disclosure" onclick={() => onChoose(false)}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 4 12 12M16 4 4 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg></button>
    </header>
    <section class="panel-info">
      <h3>Your Data Leaves This Device:</h3>
      <p>Cloud chat, AI translation and PDF Enhance send your prompts, relevant history, document text, images and tool results to <span>OpenRouter and its model providers.</span> On the website, they also pass through Docuflex’s server.</p>
      <p>Providers may change through routing or fallback and may process data outside the EU. Retention and training policies vary. <a href="https://openrouter.ai/docs/guides/privacy/provider-logging" target="_blank" rel="noreferrer">Provider policies</a> · <a href="/privacy" target="_blank" rel="noreferrer">Privacy notice</a></p>
    </section>
    <section class="panel-info">
      <h3>Your Choice:</h3>
      <p>Allow cloud AI on this device? We’ll remember your choice. You can revoke permission in Settings. Local Qwen and ordinary editing stay available without it. Paid models may charge your OpenRouter account.</p>
    </section>
    <footer class="panel-actions">
      <button class="panel-action secondary" type="button" onclick={() => onChoose(false)}>Not Now</button>
      <button class="panel-action" type="button" onclick={() => onChoose(true)}>Allow Cloud AI</button>
    </footer>
  </dialog>
</div>

<style>
  .disclosure-backdrop { position: fixed; inset: 0; z-index: 2100; display: grid; place-items: center; padding: 20px; background: rgba(0, 0, 0, 0.16); }
  .disclosure-panel { position: relative; display: block; box-sizing: border-box; width: min(480px, 100%); max-height: calc(100dvh - 40px); margin: 0; padding: 0; overflow: auto; border: 1.5px solid #c3c2c2; border-radius: 21px; background: rgba(240, 236, 236, 0.95); box-shadow: 0 4px 20px rgba(0, 0, 0, 0.05); backdrop-filter: blur(1.3px); -webkit-backdrop-filter: blur(1.3px); color: #000; font-family: "Geist Variable", Geist, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 19px; letter-spacing: -0.19px; -webkit-font-smoothing: antialiased; }
  .panel-header { display: grid; grid-template-columns: 1fr 28px; align-items: center; box-sizing: border-box; height: 50px; padding: 0 14px 0 15px; border-bottom: 1.5px solid #c3c2c2; border-radius: 19.5px 19.5px 0 0; background: rgba(214, 214, 214, 0.75); }
  .panel-header h2 { margin: 0; font-size: 20px; font-weight: 400; line-height: 1.22; letter-spacing: -0.2px; }
  .panel-close { width: 28px; height: 28px; padding: 0; border: 0; border-radius: 9px; background: transparent; color: #9d9d9d; display: grid; place-items: center; cursor: pointer; transition: transform 160ms ease, filter 160ms ease; }
  .panel-close svg { width: 20px; height: 20px; }
  .panel-close:hover { color: #000; }
  .panel-close:active { transform: scale(0.94); }
  .panel-info { padding: 16px 14px; border-bottom: 1px solid rgba(0, 0, 0, 0.1); }
  .panel-info h3 { margin: 0 0 7px; font-size: 20px; font-weight: 400; line-height: 1; letter-spacing: -0.2px; }
  .panel-info p { margin: 0; color: rgba(0, 0, 0, 0.5); font-size: 18px; line-height: 1.42; letter-spacing: -0.18px; }
  .panel-info p span { color: #0073ff; }

  .panel-actions { padding: 15px 11px 15px 12px; }
  .panel-action { display: flex; align-items: center; justify-content: center; box-sizing: border-box; width: 100%; height: 48px; padding: 0 17px; border: 0; border-radius: 15px; background: #0878f9; box-shadow: 0 5px 16px rgba(8, 120, 249, 0.22); color: #fff; font: inherit; letter-spacing: inherit; cursor: pointer; transition: opacity 150ms ease, transform 160ms ease; }
  .panel-action:hover:not(:disabled) { box-shadow: 0 6px 18px rgba(8, 120, 249, 0.32); }
  .panel-action:active { transform: scale(0.97); }
  .panel-info p + p { margin-top: 12px; }
  .panel-info h3 { line-height: 1.3; }
  .panel-actions { display: grid; grid-template-columns: 1fr 1.35fr; gap: 10px; }
  .panel-action.secondary { background: #fff; border: 1px solid rgba(0,0,0,.1); color: rgba(0,0,0,.75); box-shadow: none; }
  button:focus-visible { outline: 2px solid #0878f9; outline-offset: 2px; }
  a { color: #0073ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  @media (max-width: 380px) { .panel-actions { grid-template-columns: 1fr; } }

  /* dark theme: generated by scripts/generate-dark-theme.mjs — do not edit */
  :global(:root[data-theme="dark"]) .disclosure-backdrop { background: rgba(255, 255, 255, 0.2); }
  :global(:root[data-theme="dark"]) .disclosure-panel { border: 1.5px solid #2c2c2c; background: rgba(22, 22, 22, 0.96); box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15); color: rgba(255, 255, 255, 0.92); }
  :global(:root[data-theme="dark"]) .panel-header { border-bottom: 1.5px solid #2c2c2c; background: rgba(0, 0, 0, 0.45); }
  :global(:root[data-theme="dark"]) .panel-close { border: 0; background: transparent; color: rgba(255, 255, 255, 0.384); }
  :global(:root[data-theme="dark"]) .panel-close:hover { color: rgba(255, 255, 255, 0.92); }
  :global(:root[data-theme="dark"]) .panel-info { border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
  :global(:root[data-theme="dark"]) .panel-info p { color: rgba(255, 255, 255, 0.5); }
  :global(:root[data-theme="dark"]) .panel-info p span { color: #0073ff; }
  :global(:root[data-theme="dark"]) .panel-action { border: 0; background: #0878f9; box-shadow: 0 5px 16px rgba(8, 120, 249, 0.6); color: #111111; }
  :global(:root[data-theme="dark"]) .panel-action:hover:not(:disabled) { box-shadow: 0 6px 18px rgba(8, 120, 249, 0.6); }
  :global(:root[data-theme="dark"]) .panel-action.secondary { background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.08); color: rgba(255, 255, 255, 0.75); box-shadow: none; }
  :global(:root[data-theme="dark"]) button:focus-visible { outline: 2px solid #0878f9; }
  :global(:root[data-theme="dark"]) a { color: #0073ff; text-decoration: none; }
  :global(:root[data-theme="dark"]) a:hover { text-decoration: underline; }
  /* dark theme: end generated */

  /* dark theme: manual */
  :global(:root[data-theme="dark"]) .panel-action { background: #0878f9; color: #fff; box-shadow: 0 5px 16px rgba(8, 120, 249, 0.22); }
  :global(:root[data-theme="dark"]) .panel-close { background: transparent; color: #aaa; filter: none; }
  :global(:root[data-theme="dark"]) .panel-close:hover { color: #fff; }
  :global(:root[data-theme="dark"]) .panel-action.secondary { border-color: rgba(255,255,255,.08); background: rgba(255,255,255,.05); color: #ececec; box-shadow: none; }
  :global(:root[data-theme="dark"]) .panel-info p { color: rgba(255,255,255,.65); }
  /* dark theme: end manual */

</style>
