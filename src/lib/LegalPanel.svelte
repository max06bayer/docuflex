<script>
  import { onMount, onDestroy, tick } from 'svelte';
  import { cubicOut } from 'svelte/easing';
  import { fade, scale } from 'svelte/transition';
  import LegalContent from '#lib/LegalContent.svelte';
  /** @type {() => void} */
  export let onClose = () => {};
  export let section = 'top';
  /** @type {HTMLDialogElement | undefined} */
  let dialog;
  /** @type {HTMLDivElement | undefined} */
  let content;
  /** @type {HTMLElement | null} */
  let previousFocus = null;
  /** @param {string} next */
  function navigate(next) {
    section = next;
    const target = content?.querySelector(`[data-legal-section="${next}"]`);
    if (target instanceof HTMLElement && content) content.scrollTop = target.offsetTop;
  }
  onMount(async () => {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    await tick();
    dialog?.querySelector('button')?.focus();
    navigate(section);
  });
  onDestroy(() => previousFocus?.focus());
  /** @param {KeyboardEvent} event */
  function handleKeydown(event) {
    if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); onClose(); return; }
    if (event.key !== 'Tab' || !dialog) return;
    const fields = [...dialog.querySelectorAll('button, a[href], [tabindex="0"]')];
    const first = fields[0];
    const last = fields.at(-1);
    if (event.shiftKey && document.activeElement === first && last instanceof HTMLElement) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last && first instanceof HTMLElement) { event.preventDefault(); first.focus(); }
  }
</script>

<div class="legal-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget) onClose(); }} transition:fade={{ duration: 170 }}>
  <dialog open bind:this={dialog} class="legal-panel" aria-modal="true" aria-labelledby="legal-title" onkeydown={handleKeydown} transition:scale={{ duration: 190, easing: cubicOut, start: 0.97, opacity: 0 }}>
    <header class="panel-header">
      <h2 id="legal-title">Legal &amp; Privacy</h2>
      <button class="panel-close" type="button" aria-label="Close Legal and Privacy" onclick={onClose}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 4 12 12M16 4 4 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg></button>
    </header>
    <nav class="legal-navigation" aria-label="Legal sections">
      {#each [['top', 'Overview'], ['privacy', 'Privacy'], ['terms', 'Terms'], ['operator', 'Contact']] as [id, label]}
        <button type="button" class:active={section === id} aria-current={section === id ? 'location' : undefined} onclick={() => navigate(id)}>{label}</button>
      {/each}
    </nav>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users must be able to scroll the notice.) -->
    <div class="legal-content" bind:this={content} tabindex="0" role="document" aria-label="Legal and privacy notice"><LegalContent /></div>
    <footer class="panel-actions"><button class="panel-action" type="button" onclick={onClose}>Done</button></footer>
  </dialog>
</div>

<style>
  .legal-backdrop { position: fixed; inset: 0; z-index: 2000; display: grid; place-items: center; padding: 20px; background: rgba(0,0,0,.16); }
  .legal-panel { position: relative; display: grid; grid-template-rows: 50px auto minmax(0,1fr) auto; box-sizing: border-box; width: min(760px,100%); height: min(820px,calc(100dvh - 40px)); margin: 0; padding: 0; overflow: hidden; border: 1.5px solid #c3c2c2; border-radius: 21px; background: rgba(240,236,236,.95); box-shadow: 0 4px 20px rgba(0,0,0,.05); backdrop-filter: blur(1.3px); -webkit-backdrop-filter: blur(1.3px); color: #000; font-family: "Geist Variable", Geist, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 19px; letter-spacing: -.19px; -webkit-font-smoothing: antialiased; }
  .panel-header { display: grid; grid-template-columns: 1fr 28px; align-items: center; box-sizing: border-box; padding: 0 14px 0 15px; border-bottom: 1.5px solid #c3c2c2; background: rgba(214,214,214,.75); }
  h2 { margin: 0; font-size: 20px; font-weight: 400; line-height: 1.22; letter-spacing: -.2px; }
  .panel-close { width: 28px; height: 28px; padding: 0; border: 0; border-radius: 9px; background: transparent; color: #9d9d9d; display: grid; place-items: center; cursor: pointer; transition: transform 160ms ease; }
  .panel-close svg { width: 20px; height: 20px; }
  .panel-close:hover { color: #000; }
  .panel-close:active { transform: scale(.94); }
  .legal-navigation { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); height: 48px; box-sizing: border-box; margin: 12px; padding: 4px; gap: 4px; border: 1px solid rgba(0,0,0,.1); border-radius: 15px; background: #fff; }
  .legal-navigation button { min-width: 0; padding: 0 6px; border: 0; border-radius: 11px; background: transparent; color: rgba(0,0,0,.5); font: inherit; font-size: 18px; cursor: pointer; }
  .legal-navigation button:hover { color: #000; }
  .legal-navigation button.active, .legal-navigation button.active:hover { background: #111; color: #fff; }
  .legal-content { position: relative; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
  .panel-actions { padding: 15px 12px; border-top: 1px solid rgba(0,0,0,.1); }
  .panel-action { display: flex; align-items: center; justify-content: center; box-sizing: border-box; width: 100%; height: 48px; padding: 0 17px; border: 0; border-radius: 15px; background: #0878f9; box-shadow: 0 5px 16px rgba(8,120,249,.22); color: #fff; font: inherit; cursor: pointer; transition: transform 160ms ease; }
  .panel-action:hover { box-shadow: 0 6px 18px rgba(8,120,249,.32); }
  .panel-action:active { transform: scale(.97); }
  button:focus-visible, .legal-content:focus-visible { outline: 2px solid #0878f9; outline-offset: -3px; }
  @media (max-width: 480px) { .legal-backdrop { padding: 10px; } .legal-panel { height: calc(100dvh - 20px); } .legal-navigation { margin: 10px; } .legal-navigation button { font-size: 16px; } }

  /* dark theme: generated by scripts/generate-dark-theme.mjs — do not edit */
  :global(:root[data-theme="dark"]) .legal-backdrop { background: rgba(255, 255, 255, 0.2); }
  :global(:root[data-theme="dark"]) .legal-panel { border: 1.5px solid #2c2c2c; background: rgba(22, 22, 22, 0.96); box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15); color: rgba(255, 255, 255, 0.92); }
  :global(:root[data-theme="dark"]) .panel-header { border-bottom: 1.5px solid #2c2c2c; background: rgba(0, 0, 0, 0.45); }
  :global(:root[data-theme="dark"]) .panel-close { border: 0; background: transparent; color: rgba(255, 255, 255, 0.384); }
  :global(:root[data-theme="dark"]) .panel-close:hover { color: rgba(255, 255, 255, 0.92); }
  :global(:root[data-theme="dark"]) .legal-navigation { border: 1px solid rgba(255, 255, 255, 0.08); background: rgba(255, 255, 255, 0.05); }
  :global(:root[data-theme="dark"]) .legal-navigation button { border: 0; background: transparent; color: rgba(255, 255, 255, 0.5); }
  :global(:root[data-theme="dark"]) .legal-navigation button:hover { color: rgba(255, 255, 255, 0.92); }
  :global(:root[data-theme="dark"]) .legal-navigation button.active,
  :global(:root[data-theme="dark"]) .legal-navigation button.active:hover { background: #ececec; color: #111111; }
  :global(:root[data-theme="dark"]) .panel-actions { border-top: 1px solid rgba(255, 255, 255, 0.08); }
  :global(:root[data-theme="dark"]) .panel-action { border: 0; background: #0878f9; box-shadow: 0 5px 16px rgba(8, 120, 249, 0.6); color: #111111; }
  :global(:root[data-theme="dark"]) .panel-action:hover { box-shadow: 0 6px 18px rgba(8, 120, 249, 0.6); }
  :global(:root[data-theme="dark"]) button:focus-visible,
  :global(:root[data-theme="dark"]) .legal-content:focus-visible { outline: 2px solid #0878f9; }
  /* dark theme: end generated */

  /* dark theme: manual */
  :global(:root[data-theme="dark"]) .legal-backdrop { background: rgba(0,0,0,.32); }
  :global(:root[data-theme="dark"]) .legal-panel { border-color: #2c2c2c; background: rgba(22,22,22,.96); color: #ececec; }
  :global(:root[data-theme="dark"]) .panel-header { border-color: #2c2c2c; background: rgba(0,0,0,.45); }
  :global(:root[data-theme="dark"]) .panel-close { color: #aaa; filter: none; background: transparent; }
  :global(:root[data-theme="dark"]) .panel-close:hover { color: #fff; }
  :global(:root[data-theme="dark"]) .legal-navigation { border-color: rgba(255,255,255,.08); background: rgba(255,255,255,.05); }
  :global(:root[data-theme="dark"]) .legal-navigation button { color: rgba(255,255,255,.5); }
  :global(:root[data-theme="dark"]) .legal-navigation button:hover { color: #ececec; }
  :global(:root[data-theme="dark"]) .legal-navigation button.active,
  :global(:root[data-theme="dark"]) .legal-navigation button.active:hover { background: #ececec; color: #111; }
  :global(:root[data-theme="dark"]) .panel-actions { border-color: rgba(255,255,255,.08); }
  :global(:root[data-theme="dark"]) .panel-action { color: #fff; background: #0878f9; box-shadow: 0 5px 16px rgba(8,120,249,.22); }
  /* dark theme: end manual */

</style>
