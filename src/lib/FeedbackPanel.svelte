<script>
  import { onMount, onDestroy, tick } from 'svelte';
  import { cubicOut } from 'svelte/easing';
  import { fade, scale } from 'svelte/transition';
  import { version } from '../../package.json';
  import { isDesktopApp } from '#lib/updater.js';

  /** @type {() => void} */
  export let onClose = () => {};
  let category = 'idea';
  let message = '';
  let email = '';
  let sending = false;
  let sent = false;
  let error = '';
  /** @type {HTMLDialogElement | undefined} */
  let dialog;
  /** @type {HTMLTextAreaElement | undefined} */
  let messageInput;
  /** @type {AbortController | null} */
  let request = null;
  onMount(() => { messageInput?.focus(); });
  onDestroy(() => request?.abort());

  async function submit() {
    if (sending || !message.trim()) return;
    sending = true;
    error = '';
    request = new AbortController();
    try {
      const response = await fetch('/api/feedback', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, message: message.trim(), email: email.trim(), version, platform: isDesktopApp() ? 'desktop' : 'web' }),
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(20_000)])
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.id) throw new Error(result?.error || 'Could not send your feedback. Please try again.');
      sent = true;
      await tick();
      dialog?.querySelector('button')?.focus();
    } catch (failure) {
      if (!request.signal.aborted) error = failure instanceof Error ? failure.message : 'Could not send your feedback.';
    } finally { sending = false; request = null; }
  }

  /** @param {KeyboardEvent} event */
  function trapFocus(event) {
    if (event.key !== 'Tab' || !dialog) return;
    const fields = [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)')].filter((element) => element instanceof HTMLElement);
    const first = /** @type {HTMLElement | undefined} */ (fields[0]);
    const last = /** @type {HTMLElement | undefined} */ (fields.at(-1));
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
</script>

<div class="feedback-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget) onClose(); }} transition:fade={{ duration: 170 }}>
  <dialog open bind:this={dialog} class="feedback-panel" aria-modal="true" aria-labelledby="feedback-title" onkeydown={trapFocus} transition:scale={{ duration: 190, easing: cubicOut, start: 0.97, opacity: 0 }}>
    <header class="panel-header">
      <h2 id="feedback-title">Feedback</h2>
      <button class="panel-close" type="button" aria-label="Close Feedback" onclick={onClose}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 4 12 12M16 4 4 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg></button>
    </header>
    {#if sent}
      <section class="panel-info success" role="status">
        <h3>Thank You:</h3>
        <p>Your feedback has arrived on the <span>Docuflex server</span>.</p>
      </section>
      <footer class="panel-actions"><button class="panel-action" type="button" onclick={onClose}>Done</button></footer>
    {:else}
      <form onsubmit={(event) => { event.preventDefault(); void submit(); }}>
        <section class="feedback-fields">
          <div class="feedback-category" role="radiogroup" aria-label="Feedback type">
            {#each [['bug', 'Bug'], ['idea', 'Idea'], ['other', 'Other']] as [id, label]}
              <button type="button" role="radio" aria-checked={category === id} class:active={category === id} disabled={sending} onclick={() => (category = id)}>{label}</button>
            {/each}
          </div>
          <textarea bind:this={messageInput} bind:value={message} aria-label="Your feedback" placeholder="What could we improve?" required maxlength="5000" disabled={sending}></textarea>
          <input bind:value={email} type="email" aria-label="Email (optional)" placeholder="Email (optional)" autocomplete="email" maxlength="254" disabled={sending} />
          {#if error}<p class="panel-error" role="alert">{error}</p>{/if}
        </section>
        <section class="panel-info">
          <h3>Help Shape Docuflex:</h3>
          <p>Only this form and the app version go to our server. <span>No documents or API keys.</span> Email is optional if you’d like a reply. Feedback is kept for up to 90 days.</p>
        </section>
        <footer class="panel-actions"><button class="panel-action" type="submit" disabled={sending || !message.trim()}>{sending ? 'Sending…' : 'Send Feedback'}</button></footer>
      </form>
    {/if}
  </dialog>
</div>

<style>
  .feedback-backdrop { position: fixed; inset: 0; z-index: 120; display: grid; place-items: center; padding: 20px; background: rgba(0, 0, 0, 0.16); }
  .feedback-panel { position: relative; display: block; box-sizing: border-box; width: min(440px, 100%); max-height: calc(100dvh - 40px); margin: 0; padding: 0; overflow: auto; border: 1.5px solid #c3c2c2; border-radius: 21px; background: rgba(240, 236, 236, 0.95); box-shadow: 0 4px 20px rgba(0, 0, 0, 0.05); backdrop-filter: blur(1.3px); -webkit-backdrop-filter: blur(1.3px); color: #000; font-family: "Geist Variable", Geist, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 19px; letter-spacing: -0.19px; -webkit-font-smoothing: antialiased; }
  .panel-header { display: grid; grid-template-columns: 1fr 28px; align-items: center; box-sizing: border-box; height: 50px; padding: 0 14px 0 15px; border-bottom: 1.5px solid #c3c2c2; border-radius: 19.5px 19.5px 0 0; background: rgba(214, 214, 214, 0.75); }
  .panel-header h2 { margin: 0; font-size: 20px; font-weight: 400; line-height: 1.22; letter-spacing: -0.2px; }
  .panel-close { width: 28px; height: 28px; padding: 0; border: 0; border-radius: 9px; background: transparent; color: #9d9d9d; display: grid; place-items: center; cursor: pointer; transition: transform 160ms ease, filter 160ms ease; }
  .panel-close svg { width: 20px; height: 20px; }
  .panel-close:hover { color: #000; }
  .panel-close:active { transform: scale(0.94); }
  .feedback-fields { display: grid; gap: 10px; padding: 12px 11px 12px 12px; border-bottom: 1px solid rgba(0, 0, 0, 0.1); }
  .feedback-category { display: grid; grid-template-columns: repeat(3, 1fr); box-sizing: border-box; height: 48px; padding: 4px; gap: 4px; border: 1px solid rgba(0, 0, 0, 0.1); border-radius: 15px; background: #fff; }
  .feedback-category button { padding: 0 8px; border: 0; border-radius: 11px; background: transparent; color: rgba(0, 0, 0, 0.5); font: inherit; font-size: 19px; letter-spacing: -0.19px; cursor: pointer; transition: color 170ms ease, background-color 220ms cubic-bezier(0.22, 1, 0.36, 1); }
  .feedback-category button:hover:not(:disabled) { color: #000; }
  .feedback-category button.active,
  .feedback-category button.active:hover:not(:disabled) { background: #111; color: #fff; }
  textarea, input { box-sizing: border-box; width: 100%; min-width: 0; padding: 13px; border: 1px solid rgba(0, 0, 0, 0.1); border-radius: 15px; outline: 0; background: #fff; color: rgba(0, 0, 0, 0.75); font: inherit; font-size: 18px; line-height: 1.35; letter-spacing: inherit; }
  textarea { height: 170px; resize: none; }
  input { height: 48px; }
  textarea:focus, input:focus { border-color: rgba(0, 0, 0, 0.28); }
  textarea::placeholder, input::placeholder { color: rgba(0, 0, 0, 0.5); opacity: 1; }
  .panel-error { margin: 0; color: #de3542; font-size: 16px; line-height: 1.35; }
  .panel-info { padding: 16px 14px; border-bottom: 1px solid rgba(0, 0, 0, 0.1); }
  .panel-info h3 { margin: 0 0 7px; font-size: 20px; font-weight: 400; line-height: 1; letter-spacing: -0.2px; }
  .panel-info p { margin: 0; color: rgba(0, 0, 0, 0.5); font-size: 18px; line-height: 1.42; letter-spacing: -0.18px; }
  .panel-info p span { color: #0073ff; }
  .success { padding-top: 24px; padding-bottom: 24px; }
  .panel-actions { padding: 15px 11px 15px 12px; }
  .panel-action { display: flex; align-items: center; justify-content: center; box-sizing: border-box; width: 100%; height: 48px; padding: 0 17px; border: 0; border-radius: 15px; background: #0878f9; box-shadow: 0 5px 16px rgba(8, 120, 249, 0.22); color: #fff; font: inherit; letter-spacing: inherit; cursor: pointer; transition: opacity 150ms ease, transform 160ms ease; }
  .panel-action:hover:not(:disabled) { box-shadow: 0 6px 18px rgba(8, 120, 249, 0.32); }
  .panel-action:active { transform: scale(0.97); }
  button:disabled { cursor: default; opacity: 0.5; }

  /* dark theme: generated by scripts/generate-dark-theme.mjs — do not edit */
  :global(:root[data-theme="dark"]) .feedback-backdrop { background: rgba(255, 255, 255, 0.2); }
  :global(:root[data-theme="dark"]) .feedback-panel { border: 1.5px solid #2c2c2c; background: rgba(22, 22, 22, 0.96); box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15); color: rgba(255, 255, 255, 0.92); }
  :global(:root[data-theme="dark"]) .panel-header { border-bottom: 1.5px solid #2c2c2c; background: rgba(0, 0, 0, 0.45); }
  :global(:root[data-theme="dark"]) .panel-close { border: 0; background: transparent; color: rgba(255, 255, 255, 0.384); }
  :global(:root[data-theme="dark"]) .panel-close:hover { color: rgba(255, 255, 255, 0.92); }
  :global(:root[data-theme="dark"]) .feedback-fields { border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
  :global(:root[data-theme="dark"]) .feedback-category { border: 1px solid rgba(255, 255, 255, 0.08); background: rgba(255, 255, 255, 0.05); }
  :global(:root[data-theme="dark"]) .feedback-category button { border: 0; background: transparent; color: rgba(255, 255, 255, 0.5); }
  :global(:root[data-theme="dark"]) .feedback-category button:hover:not(:disabled) { color: rgba(255, 255, 255, 0.92); }
  :global(:root[data-theme="dark"]) .feedback-category button.active,
  :global(:root[data-theme="dark"]) .feedback-category button.active:hover:not(:disabled) { background: #ececec; color: #111111; }
  :global(:root[data-theme="dark"]) textarea,
  :global(:root[data-theme="dark"]) input { border: 1px solid rgba(255, 255, 255, 0.08); outline: 0; background: rgba(255, 255, 255, 0.05); color: rgba(255, 255, 255, 0.75); }
  :global(:root[data-theme="dark"]) textarea:focus,
  :global(:root[data-theme="dark"]) input:focus { border-color: rgba(255, 255, 255, 0.224); }
  :global(:root[data-theme="dark"]) textarea::placeholder,
  :global(:root[data-theme="dark"]) input::placeholder { color: rgba(255, 255, 255, 0.5); }
  :global(:root[data-theme="dark"]) .panel-error { color: #de3542; }
  :global(:root[data-theme="dark"]) .panel-info { border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
  :global(:root[data-theme="dark"]) .panel-info p { color: rgba(255, 255, 255, 0.5); }
  :global(:root[data-theme="dark"]) .panel-info p span { color: #0073ff; }
  :global(:root[data-theme="dark"]) .panel-action { border: 0; background: #0878f9; box-shadow: 0 5px 16px rgba(8, 120, 249, 0.6); color: #111111; }
  :global(:root[data-theme="dark"]) .panel-action:hover:not(:disabled) { box-shadow: 0 6px 18px rgba(8, 120, 249, 0.6); }
  /* dark theme: end generated */

  /* dark theme: manual */
  :global(:root[data-theme="dark"]) .panel-action { background: #0878f9; color: #fff; box-shadow: 0 5px 16px rgba(8, 120, 249, 0.22); }
  :global(:root[data-theme="dark"]) .panel-close { background: transparent; color: #aaa; filter: none; }
  :global(:root[data-theme="dark"]) .panel-close:hover { color: #fff; }
  /* dark theme: end manual */

</style>
