<script>
  export let id = '';
  export let selected = false;
  $: provider = id.split('/')[0];
  $: known = ['xiaomi', 'google', 'anthropic', 'openai', 'moonshotai', 'openrouter', 'dots-studio', 'minimax', 'nvidia'].includes(provider);
</script>

<span class="model-logo" class:selected aria-hidden="true">
  {#if provider === 'ollama'}<svg viewBox="0 0 24 24" fill="none"><path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M5.6 18.4 18.4 5.6" stroke="url(#qwen-local)" stroke-width="2.5" stroke-linecap="round"/><defs><linearGradient id="qwen-local" x1="3" y1="3" x2="21" y2="21"><stop stop-color="#30c5ff"/><stop offset=".5" stop-color="#ac6bff"/><stop offset="1" stop-color="#ff6ea9"/></linearGradient></defs></svg>
  {:else if known}<img src={`/model-logos/${provider}.svg`} alt="" width="17" height="17" />
  {:else}<svg viewBox="0 0 24 24" fill="none"><path d="m12 3 9 9-9 9-9-9Z" stroke="currentColor" stroke-width="1.5" /></svg>{/if}
</span>

<style>
  .model-logo { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; flex: none; filter: grayscale(1); opacity: .48; }
  .model-logo.selected { filter: none; opacity: 1; }
  img, svg { display: block; width: 17px; height: 17px; object-fit: contain; }
  /* dark theme: manual */
  :global(:root[data-theme="dark"]) .model-logo:not(.selected) { filter: grayscale(1) brightness(1.8); opacity: .65; }
  :global(:root[data-theme="dark"]) .model-logo:not(.selected) img[src$="/moonshotai.svg"] { filter: invert(1); }
  :global(:root[data-theme="dark"]) .model-logo img[src$="/openai.svg"] { filter: invert(1); }
  /* dark theme: end manual */
</style>
