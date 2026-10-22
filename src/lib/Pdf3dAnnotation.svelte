<script>
  import { onDestroy } from 'svelte';
  import { loadPdf3dModel } from './pdf3d/load.js';

  /**
   * A 3D annotation on a page. The page canvas already shows its poster; this
   * adds a button that swaps the poster for a live, rotatable view. The
   * editor shows the controls for the active view in its side panel.
   * @type {{
   *   rect: { x: number; y: number; width: number; height: number };
   *   annotationRef: number;
   *   getPdfBytes: () => ArrayBuffer | null;
   *   onSession: (session: import('./pdf3d/load.js').Pdf3dSession | null) => void;
   * }}
   */
  let { rect, annotationRef, getPdfBytes, onSession } = $props();

  /** @type {'idle' | 'loading' | 'active' | 'error'} */
  let status = $state('idle');
  let error = $state('');
  /** @type {HTMLCanvasElement | undefined} */
  let canvas = $state();
  /** @type {import('./pdf3d/viewer.js').Pdf3dViewer | null} */
  let viewer = null;

  async function activate() {
    if (status === 'loading' || status === 'active') return;
    status = 'loading';
    error = '';
    try {
      const bytes = getPdfBytes();
      if (!bytes) throw new Error('The document is still loading.');
      const [{ content, model }, { Pdf3dViewer }] = await Promise.all([
        loadPdf3dModel(bytes, annotationRef),
        import('./pdf3d/viewer.js')
      ]);
      status = 'active';
      // The canvas exists once the active markup has rendered.
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (!canvas) throw new Error('Could not start the 3D view.');
      const activeViewer = new Pdf3dViewer(canvas, model, content.view);
      viewer = activeViewer;
      onSession({
        views: content.views.map((view, index) => view.name || `View ${index + 1}`),
        selectView: (index) => activeViewer.setView(index < 0 ? content.view : content.views[index] ?? content.view),
        close: deactivate
      });
    } catch (cause) {
      console.error(cause);
      viewer?.dispose();
      viewer = null;
      status = 'error';
      error = cause instanceof Error ? cause.message : 'Could not show the 3D model.';
    }
  }

  function deactivate() {
    viewer?.dispose();
    viewer = null;
    status = 'idle';
    onSession(null);
  }

  /**
   * Keeps page tools (pan, zoom, drawing, selection) from starting inside the
   * view. Moves and releases must still bubble: the orbit controls listen for
   * them on the document.
   * @param {Event} event
   */
  function isolate(event) {
    event.stopPropagation();
  }

  /** @param {WheelEvent} event */
  function isolateWheel(event) {
    event.stopPropagation();
    event.preventDefault();
  }

  onDestroy(() => {
    if (viewer) deactivate();
  });
</script>

<div
  class="pdf3d"
  class:active={status === 'active'}
  style:left={`${rect.x}px`}
  style:top={`${rect.y}px`}
  style:width={`${rect.width}px`}
  style:height={`${rect.height}px`}
>
  {#if status === 'active' || status === 'loading'}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="pdf3d-stage"
      class:loading={status === 'loading'}
      onpointerdown={isolate}
      onclick={isolate}
      ondblclick={isolate}
      oncontextmenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onwheel={isolateWheel}
      onkeydown={isolate}
    >
      <canvas bind:this={canvas} aria-label="3D model. Drag to rotate, right-drag to pan, scroll to zoom."></canvas>
      {#if status === 'loading'}
        <span class="pdf3d-pill pdf3d-status">Loading 3D model…</span>
      {/if}
    </div>
  {:else}
    <button type="button" class="pdf3d-pill pdf3d-activate" onpointerdown={isolate} onclick={activate}>
      <img src="/toolbar/small/cube.svg" alt="" />
      <span>{status === 'error' ? 'Try 3D again' : 'View in 3D'}</span>
    </button>
    {#if status === 'error'}
      <span class="pdf3d-pill pdf3d-error" role="status">{error}</span>
    {/if}
  {/if}
</div>

<style>
  .pdf3d {
    position: absolute;
    z-index: 4;
    pointer-events: none;
  }

  .pdf3d.active {
    pointer-events: auto;
  }

  .pdf3d-stage {
    position: absolute;
    inset: 0;
    overflow: hidden;
    background: #fff;
    cursor: grab;
    touch-action: none;
  }

  .pdf3d-stage:active {
    cursor: grabbing;
  }

  .pdf3d-stage.loading {
    background: rgba(255, 255, 255, 0.55);
    cursor: progress;
  }

  .pdf3d-stage canvas {
    display: block;
    width: 100%;
    height: 100%;
    outline: none;
  }

  /* Same surface as the editor's side panels (.protect-panel). */
  .pdf3d-pill {
    position: absolute;
    top: 50%;
    left: 50%;
    display: flex;
    align-items: center;
    gap: 8px;
    box-sizing: border-box;
    height: 39px;
    padding: 0 16px 0 13px;
    border: 1.5px solid #c3c2c2;
    border-radius: 21px;
    background: rgba(240, 236, 236, 0.75);
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.05);
    color: #000;
    font-family: "Geist Variable", Geist, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 16px;
    white-space: nowrap;
    backdrop-filter: blur(1.3px);
    -webkit-backdrop-filter: blur(1.3px);
    -webkit-font-smoothing: antialiased;
    transform: translate(-50%, -50%);
  }

  .pdf3d-activate {
    cursor: pointer;
    pointer-events: auto;
    transition: background-color 150ms ease, border-color 150ms ease;
  }

  .pdf3d-activate:hover {
    border-color: #a9a8a8;
    background: rgba(240, 236, 236, 0.95);
  }

  .pdf3d-activate:active {
    transform: translate(-50%, -50%) scale(0.97);
  }

  .pdf3d-activate img {
    width: 22px;
    height: 22px;
  }

  .pdf3d-status {
    pointer-events: none;
  }

  .pdf3d-error {
    top: calc(50% + 46px);
    max-width: min(320px, calc(100% - 20px));
    height: auto;
    padding: 8px 14px;
    color: #b3261e;
    font-size: 14px;
    white-space: normal;
    pointer-events: auto;
  }

  /* dark theme: generated by scripts/generate-dark-theme.mjs — do not edit */
  :global(:root[data-theme="dark"]) .pdf3d-stage { background: rgba(255, 255, 255, 0.05); }
  :global(:root[data-theme="dark"]) .pdf3d-stage.loading { background: rgba(255, 255, 255, 0.07); }
  :global(:root[data-theme="dark"]) .pdf3d-stage canvas { outline: none; }
  :global(:root[data-theme="dark"]) .pdf3d-pill { border: 1.5px solid #2c2c2c; background: rgba(22, 22, 22, 0.96); box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15); color: rgba(255, 255, 255, 0.92); }
  :global(:root[data-theme="dark"]) .pdf3d-activate:hover { border-color: #383838; background: rgba(22, 22, 22, 0.96); }
  :global(:root[data-theme="dark"]) .pdf3d-error { color: #b3261e; }
  /* dark theme: end generated */

  /* dark theme: manual */
  :global(:root[data-theme="dark"]) .pdf3d-pill { border-color: #2c2c2c; background: rgba(22, 22, 22, 0.96); box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15); color: rgba(255, 255, 255, 0.92); }
  :global(:root[data-theme="dark"]) .pdf3d-activate:hover { border-color: #3a3a3a; background: rgba(30, 30, 30, 0.98); }
  :global(:root[data-theme="dark"]) .pdf3d-error { color: #ff8a80; }

</style>
