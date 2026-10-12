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
  let now = Date.now();

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

  /** @param {number} at */
  function ago(at) {
    const seconds = Math.max(0, Math.round((now - at) / 1000));
    if (seconds < 5) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.round(seconds / 60);
    return minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
  }

  /** @param {KeyboardEvent} event */
  function handleKeydown(event) {
    if (event.key === 'Escape') onClose();
  }

  onMount(() => {
    window.addEventListener('keydown', handleKeydown);
    refreshTimer = setInterval(() => {
      now = Date.now();
      onRefresh();
    }, 3000);
  });

  onDestroy(() => {
    if (typeof window !== 'undefined') window.removeEventListener('keydown', handleKeydown);
    clearInterval(refreshTimer);
    clearTimeout(copiedTimer);
  });
</script>

<div class="mcp-panel" role="dialog" aria-label="MCP Server" transition:fly={{ x: 18, duration: 240, easing: cubicOut }}>
  <header class="panel-header">
    <img src="/mcp.svg" alt="" />
    <h2>MCP Server</h2>
    <button class="panel-close" type="button" aria-label="Close MCP Server" onclick={onClose}><span></span><span></span></button>
  </header>

  <div class="mcp-content">
    <section class="mcp-section">
      <button
        class:active={status?.enabled}
        class="mcp-toggle"
        type="button"
        aria-pressed={Boolean(status?.enabled)}
        disabled={!status}
        onclick={() => onToggle(!status?.enabled)}
      >
        <span>Server</span>
        <em>{status?.enabled ? 'On' : 'Off'}</em>
      </button>
      <p class="mcp-status">
        <span class="mcp-dot" class:live={status?.enabled && status.connectedApps > 0} class:off={!status?.enabled}></span>
        {#if !status}
          Checking…
        {:else if !status.enabled}
          Off. AI agents can't connect.
        {:else if status.connectedApps === 0}
          Running, waiting for the editor window.
        {:else if status.lastCall}
          Running. Last action <strong>{status.lastCall.name}</strong> {ago(status.lastCall.at)}.
        {:else}
          Running and ready for AI agents.
        {/if}
      </p>
    </section>

    <section class="mcp-section">
      <span class="mcp-label">Address</span>
      <div class="mcp-field">
        <input value={url} readonly aria-label="MCP server address" onfocus={(event) => event.currentTarget.select()} />
        <button type="button" onclick={() => copy('url', url)} disabled={!url}>{copied === 'url' ? 'Copied' : 'Copy'}</button>
      </div>

      <span class="mcp-label">Connect an agent</span>
      <button class="mcp-copy-row" type="button" onclick={() => copy('claude', claudeCommand)} disabled={!url}>
        <span>Claude Code command</span>
        <em>{copied === 'claude' ? 'Copied' : 'Copy'}</em>
      </button>
      <button class="mcp-copy-row" type="button" onclick={() => copy('json', jsonConfig)} disabled={!url}>
        <span>JSON config (Cursor, Claude Desktop …)</span>
        <em>{copied === 'json' ? 'Copied' : 'Copy'}</em>
      </button>
    </section>

    <p class="mcp-footnote">{status?.toolCount ?? 0} tools · only reachable from this computer</p>
  </div>
</div>

<style>
  .mcp-panel {
    position: fixed;
    z-index: 70;
    top: 70px;
    right: 14px;
    display: grid;
    grid-template-rows: 50px auto;
    width: min(340px, calc(100% - 28px));
    border: 1.5px solid #c5c5c5;
    border-radius: 13px;
    overflow: hidden;
    background: #fafafa;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.12);
    color: #000;
    font-family: "Inter Variable", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
  }

  .panel-header {
    display: grid;
    grid-template-columns: 26px 1fr 28px;
    align-items: center;
    height: 50px;
    padding: 0 12px;
    border-bottom: 1px solid #cacaca;
    background: #eeeeee;
  }

  .panel-header > img { width: 24px; height: 24px; }

  .panel-header h2 {
    margin: 0 0 0 7px;
    font-size: 18px;
    font-weight: 400;
    line-height: 1.22;
    letter-spacing: -0.25px;
  }

  .panel-close {
    position: relative;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 9px;
    background: transparent;
    cursor: pointer;
    transition: transform 160ms ease;
  }

  .panel-close:active { transform: scale(0.94); }

  .panel-close span {
    position: absolute;
    top: 13px;
    left: 6px;
    width: 16px;
    height: 1.5px;
    border-radius: 99px;
    background: #929292;
    transform: rotate(45deg);
    transition: background-color 160ms ease;
  }

  .panel-close span + span { transform: rotate(-45deg); }
  .panel-close:hover span { background: #000; }

  .mcp-content { display: grid; min-width: 0; }

  .mcp-section {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 10px;
    padding: 16px 18px;
    border-bottom: 1px solid #dedede;
  }

  .mcp-toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 42px;
    padding: 0 12px;
    border: 1px solid #d7d7d7;
    border-radius: 8px;
    background: #f3f3f3;
    color: #111;
    font: inherit;
    font-size: 18px;
    cursor: pointer;
    transition: background-color 150ms ease, color 150ms ease, border-color 150ms ease, transform 160ms ease;
  }

  .mcp-toggle:active { transform: scale(0.985); }
  .mcp-toggle em { color: #7a7a7a; font-style: normal; transition: color 150ms ease; }
  .mcp-toggle.active { border-color: #111; background: #111; color: #fff; }
  .mcp-toggle.active em { color: #fff; }
  .mcp-toggle:disabled { cursor: default; opacity: 0.6; }

  .mcp-status {
    margin: 0;
    overflow-wrap: anywhere;
    color: #7a7a7a;
    font-size: 16px;
    line-height: 1.38;
    letter-spacing: -0.2px;
  }

  .mcp-status strong { color: #000; font-weight: 400; }

  .mcp-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    margin-right: 7px;
    border-radius: 50%;
    background: #f0a020;
    vertical-align: 1px;
  }

  .mcp-dot.live { background: #2fb344; box-shadow: 0 0 0 3px rgba(47, 179, 68, 0.18); }
  .mcp-dot.off { background: #b8b8b8; }

  .mcp-label {
    margin-top: 2px;
    color: #7a7a7a;
    font-size: 15px;
    letter-spacing: -0.2px;
  }

  .mcp-field {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    height: 42px;
    overflow: hidden;
    border: 1px solid #d7d7d7;
    border-radius: 8px;
    background: #f3f3f3;
  }

  .mcp-field input {
    min-width: 0;
    height: 100%;
    padding: 0 12px;
    border: 0;
    outline: 0;
    background: transparent;
    color: #111;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 14px;
  }

  .mcp-field button {
    height: 100%;
    padding: 0 14px;
    border: 0;
    border-left: 1px solid #d7d7d7;
    background: #0878f9;
    color: #fff;
    font: inherit;
    font-size: 16px;
    cursor: pointer;
    transition: background-color 180ms ease;
  }

  .mcp-field button:hover { background: #006ff0; }
  .mcp-field button:disabled { cursor: default; opacity: 0.5; }

  .mcp-copy-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    height: 40px;
    padding: 0 12px;
    border: 1px solid #d7d7d7;
    border-radius: 8px;
    background: #f3f3f3;
    color: #3f3f3f;
    font: inherit;
    font-size: 16px;
    text-align: left;
    cursor: pointer;
    transition: background-color 180ms ease, border-color 180ms ease;
  }

  .mcp-copy-row:hover { border-color: #c8c8c8; background: #eeeeee; }
  .mcp-copy-row span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mcp-copy-row em { flex: none; color: #0878f9; font-style: normal; }
  .mcp-copy-row:disabled { cursor: default; opacity: 0.5; }

  .mcp-footnote {
    margin: 0;
    padding: 12px 18px 14px;
    color: #9a9a9a;
    font-size: 14px;
    letter-spacing: -0.15px;
  }
</style>
