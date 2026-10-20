<script>
  import { onDestroy, onMount } from 'svelte';
  import { cubicOut } from 'svelte/easing';
  import { fly } from 'svelte/transition';

  /** @type {() => void} */
  export let onClose = () => {};
  /** @type {{ available: boolean; enabled: boolean; url: string; connectedApps: number; toolCount: number; lastCall: { name: string; at: number } | null } | null} */
  export let status = null;
  /** @type {(enabled: boolean) => Promise<void> | void} */
  export let onToggle = () => {};
  /** @type {() => void} */
  export let onRefresh = () => {};

  /** @type {string | null} */
  let copied = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let copiedTimer;
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let refreshTimer;

  $: url = status?.url ?? '';
  $: claudeCommand = url ? `claude mcp add --transport http docuflex ${url}` : '';
  $: jsonConfig = url ? JSON.stringify({ mcpServers: { docuflex: { type: 'http', url } } }, null, 2) : '';

  /** @param {string} key @param {string} value */
  async function copy(key, value) {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const area = document.createElement('textarea');
      area.value = value;
      document.body.append(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    copied = key;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied = null), 1600);
  }

  /** @param {KeyboardEvent} event */
  function handleKeydown(event) {
    if (event.key === 'Escape') onClose();
  }

  onMount(() => {
    window.addEventListener('keydown', handleKeydown);
    refreshTimer = setInterval(onRefresh, 3000);
  });

  onDestroy(() => {
    if (typeof window !== 'undefined') window.removeEventListener('keydown', handleKeydown);
    clearInterval(refreshTimer);
    clearTimeout(copiedTimer);
  });
</script>

<div class="mcp-panel" role="dialog" aria-label="MCP Server" transition:fly={{ x: 18, duration: 240, easing: cubicOut }}>
  <header class="panel-header">
    <img src="/redesign/icon-code-xml.svg" alt="" />
    <h2>MCP Server</h2>
    <button class="panel-close" type="button" aria-label="Close MCP Server" onclick={onClose}></button>
  </header>

  <section class="mcp-section">
    <button
      class:active={status?.enabled}
      class="mcp-row mcp-toggle"
      type="button"
      aria-pressed={Boolean(status?.enabled)}
      disabled={!status}
      onclick={() => onToggle(!status?.enabled)}
    >
      <span>Server</span>
      <em>{status?.enabled ? 'On' : 'Off'}</em>
    </button>
  </section>

  <section class="mcp-section">
    <button class="mcp-row mcp-copy mcp-address" type="button" title={url} onclick={() => copy('url', url)} disabled={!url}>
      <code>{url.replace(/^https?:\/\//, '')}</code>
      {#if copied === 'url'}<em>Copied</em>{:else}<img src="/redesign/icon-copy2.svg" alt="" />{/if}
    </button>
    <button class="mcp-row mcp-copy" type="button" onclick={() => copy('claude', claudeCommand)} disabled={!url}>
      <span>Claude Code</span>
      <code></code>
      {#if copied === 'claude'}<em>Copied</em>{:else}<img src="/redesign/icon-copy2.svg" alt="" />{/if}
    </button>
    <button class="mcp-row mcp-copy" type="button" onclick={() => copy('json', jsonConfig)} disabled={!url}>
      <span>JSON Config</span>
      <code></code>
      {#if copied === 'json'}<em>Copied</em>{:else}<img src="/redesign/icon-copy2.svg" alt="" />{/if}
    </button>
  </section>
</div>

<style>
  /* Matches the editor's right-hand panels (PdfEditor .protect-panel). */
  .mcp-panel {
    position: fixed;
    z-index: 70;
    top: 68px;
    right: 13px;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    box-sizing: border-box;
    width: min(320px, calc(100% - 26px));
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

  .panel-header {
    display: grid;
    grid-template-columns: 24px 1fr 28px;
    align-items: center;
    box-sizing: border-box;
    height: 50px;
    padding: 0 14px 0 15px;
    border-bottom: 1.5px solid #c3c2c2;
    background: rgba(214, 214, 214, 0.75);
  }

  .panel-header > img { width: 24px; height: 24px; }

  .panel-header h2 {
    margin: 0 0 0 8px;
    font-size: 20px;
    font-weight: 400;
    line-height: 1.22;
    letter-spacing: -0.2px;
  }

  .panel-close {
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 9px;
    background: url('/redesign/panel-close.svg') center / 12.67px 12.67px no-repeat;
    cursor: pointer;
    transition: transform 160ms ease, filter 160ms ease;
  }

  .panel-close:hover { filter: brightness(0); }
  .panel-close:active { transform: scale(0.94); }

  .mcp-section {
    display: grid;
    gap: 10px;
    padding: 15px 11px 15px 12px;
    border-bottom: 1px solid rgba(0, 0, 0, 0.1);
  }

  .mcp-section:last-child { border-bottom: 0; }

  .mcp-row {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 10px;
    box-sizing: border-box;
    width: 100%;
    height: 48px;
    padding: 0 13px;
    border: 1px solid rgba(0, 0, 0, 0.1);
    border-radius: 15px;
    background: #fff;
    color: rgba(0, 0, 0, 0.75);
    font: inherit;
    letter-spacing: inherit;
    text-align: left;
    cursor: pointer;
    transition: background-color 150ms ease, color 150ms ease, border-color 150ms ease, transform 160ms ease;
  }

  .mcp-row:active { transform: scale(0.985); }
  .mcp-row:disabled { cursor: default; opacity: 0.5; }
  .mcp-row span { color: rgba(0, 0, 0, 0.5); white-space: nowrap; }
  .mcp-row em { color: rgba(0, 0, 0, 0.5); font-style: normal; }

  .mcp-toggle { grid-template-columns: 1fr auto; }
  .mcp-toggle span { color: rgba(0, 0, 0, 0.75); }
  .mcp-toggle.active { border-color: #111; background: #111; }
  .mcp-toggle.active span,
  .mcp-toggle.active em { color: #fff; }

  .mcp-copy:not(:disabled):hover { background: rgba(255, 255, 255, 0.7); }
  .mcp-copy img { width: 19px; height: 20px; opacity: 0.85; }
  .mcp-copy:hover img { opacity: 1; }

  .mcp-copy code {
    overflow: hidden;
    color: rgba(0, 0, 0, 0.75);
    font-family: inherit;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mcp-address { grid-template-columns: minmax(0, 1fr) auto; }

  /* dark theme: generated by scripts/generate-dark-theme.mjs — do not edit */
  :global(:root[data-theme="dark"]) .mcp-panel { border: 1.5px solid #2c2c2c; background: rgba(22, 22, 22, 0.96); box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15); color: rgba(255, 255, 255, 0.92); }
  :global(:root[data-theme="dark"]) .panel-header { border-bottom: 1.5px solid #2c2c2c; background: rgba(0, 0, 0, 0.45); }
  :global(:root[data-theme="dark"]) .panel-close { filter: brightness(0) invert(1) opacity(0.78); }
  :global(:root[data-theme="dark"]) .panel-close:hover { filter: brightness(0) invert(1); }
  :global(:root[data-theme="dark"]) .mcp-section { border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
  :global(:root[data-theme="dark"]) .mcp-row { border: 1px solid rgba(255, 255, 255, 0.08); background: rgba(255, 255, 255, 0.05); color: rgba(255, 255, 255, 0.75); }
  :global(:root[data-theme="dark"]) .mcp-row span { color: rgba(255, 255, 255, 0.5); }
  :global(:root[data-theme="dark"]) .mcp-row em { color: rgba(255, 255, 255, 0.5); }
  :global(:root[data-theme="dark"]) .mcp-toggle span { color: rgba(255, 255, 255, 0.75); }
  :global(:root[data-theme="dark"]) .mcp-toggle.active { border-color: #ececec; background: #ececec; }
  :global(:root[data-theme="dark"]) .mcp-toggle.active span,
  :global(:root[data-theme="dark"]) .mcp-toggle.active em { color: #111111; }
  :global(:root[data-theme="dark"]) .mcp-copy:not(:disabled):hover { background: rgba(255, 255, 255, 0.07); }
  :global(:root[data-theme="dark"]) .mcp-copy code { color: rgba(255, 255, 255, 0.75); }
  /* dark theme: end generated */

</style>
