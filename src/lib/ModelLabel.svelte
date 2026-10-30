<script>
  import ModelLogo from '#lib/ModelLogo.svelte';
  /** @type {{ id: string; name: string; short?: string; free?: boolean; local?: boolean; downloadable?: boolean; ready?: boolean } | undefined} */
  export let model = undefined;
  export let selected = false;
  export let compact = false;
</script>

<span class="model-label" class:free={model?.free} class:compact title={model?.name}>
  {#if model}<ModelLogo id={model.id} {selected} />{/if}
  <span class="model-name">{(compact ? model?.short : model?.name) ?? model?.name ?? '…'}</span>
  {#if model?.free}<span class="free-tag">:FREE</span>{/if}
</span>

<style>
  .model-label { display: inline-flex; align-items: center; gap: 7px; min-width: 0; width: 100%; }
  .model-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .free-tag { flex: none; margin-left: auto; font-family: "Geist Mono Variable", "Geist Mono", ui-monospace, monospace; font-weight: 300; font-size: 12px; }
  .compact .free-tag { font-size: inherit; margin-left: 0; }
  .free { color: #1674d5; }
  /* dark theme: manual */
  :global(:root[data-theme="dark"]) .free { color: #69b2ff; }
  /* dark theme: end manual */
</style>
