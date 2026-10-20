<script>
  import { onDestroy, onMount } from 'svelte';

  /**
   * The AI sidebar's backdrop: a field of grey mono characters gathered into
   * slow drifting clouds. Near the pointer they scramble and darken.
   * Drawn on one canvas at ~30 fps, and only while the sidebar is open.
   */

  /** Runs only while true (the sidebar is open and the window visible). */
  export let active = true;
  /** 0–1: fades the field back while a conversation needs the space. */
  export let strength = 1;

  const CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const FONT_SIZE = 11;
  const CELL_W = 7;
  const CELL_H = 14;
  const FRAME_MS = 33;
  const POINTER_RADIUS = 150;

  /** @type {HTMLCanvasElement | undefined} */
  let canvas;
  /** @type {CanvasRenderingContext2D | null} */
  let context = null;
  let columns = 0;
  let rows = 0;
  /** @type {string[]} */
  let glyphs = [];
  let frame = 0;
  let lastFrame = 0;
  let time = Math.random() * 1000;
  /** Pointer in canvas pixels; far away when it is not over the panel. */
  let pointer = { x: -9999, y: -9999 };
  let reducedMotion = false;
  /** @type {ResizeObserver | undefined} */
  let observer;

  /** Random lattice for value noise. */
  const LATTICE = Array.from({ length: 256 }, () => Math.random());
  const PERM = Array.from({ length: 512 }, (_, index) => index % 256).sort(() => Math.random() - 0.5);

  /** @param {number} x @param {number} y */
  function lattice(x, y) {
    return LATTICE[PERM[(PERM[x & 255] + y) & 511] & 255];
  }

  /** Smooth 2D value noise in 0–1. @param {number} x @param {number} y */
  function noise(x, y) {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const top = lattice(x0, y0) + (lattice(x0 + 1, y0) - lattice(x0, y0)) * sx;
    const bottom = lattice(x0, y0 + 1) + (lattice(x0 + 1, y0 + 1) - lattice(x0, y0 + 1)) * sx;
    return top + (bottom - top) * sy;
  }

  function randomGlyph() {
    return CHARS[Math.floor(Math.random() * CHARS.length)];
  }

  function resize() {
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    context = canvas.getContext('2d');
    context?.setTransform(ratio, 0, 0, ratio, 0, 0);
    columns = Math.ceil(width / CELL_W) + 1;
    rows = Math.ceil(height / CELL_H) + 1;
    glyphs = Array.from({ length: columns * rows }, randomGlyph);
    draw();
  }

  function draw() {
    if (!context || !canvas) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    context.clearRect(0, 0, width, height);
    if (strength <= 0) return;
    context.font = `${FONT_SIZE}px "Geist Mono Variable", "Geist Mono", ui-monospace, Menlo, monospace`;
    context.textBaseline = 'top';
    const drift = time * 0.00004;
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const x = column * CELL_W;
        const y = row * CELL_H;
        // Two octaves of drifting noise make the clouds; below the threshold stays empty.
        const cloud = noise(column * 0.045 + drift * 60, row * 0.07 - drift * 25) * 0.7 + noise(column * 0.13 - drift * 90, row * 0.18 + drift * 40) * 0.3;
        const distance = Math.hypot(x - pointer.x, y - pointer.y);
        const near = distance < POINTER_RADIUS ? 1 - distance / POINTER_RADIUS : 0;
        const density = (cloud - 0.5) * 3.2 + near * 0.7;
        if (density <= 0) continue;
        const alpha = Math.min(1, density) * 0.32 * strength;
        const index = row * columns + column;
        if (near > 0.15 && Math.random() < near * 0.35) glyphs[index] = randomGlyph();
        // Neutral grey throughout; towards the pointer it only gets darker.
        const shade = Math.round(120 - 35 * near);
        context.fillStyle = `rgba(${shade}, ${shade}, ${shade}, ${alpha + near * near * 0.1 * strength})`;
        context.fillText(glyphs[index], x, y);
      }
    }
  }

  /** @param {number} now */
  function tick(now) {
    frame = requestAnimationFrame(tick);
    if (now - lastFrame < FRAME_MS) return;
    time += now - lastFrame;
    lastFrame = now;
    // A slow shimmer: a few glyphs change every frame everywhere.
    for (let count = 0; count < glyphs.length * 0.01; count += 1) {
      glyphs[Math.floor(Math.random() * glyphs.length)] = randomGlyph();
    }
    draw();
  }

  function start() {
    if (frame || reducedMotion || !active || document.hidden) return;
    lastFrame = performance.now();
    frame = requestAnimationFrame(tick);
  }

  function stopLoop() {
    cancelAnimationFrame(frame);
    frame = 0;
  }

  /** @param {PointerEvent} event */
  function handlePointerMove(event) {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    // The app is zoomed; map screen pixels back to canvas pixels.
    const scale = rect.width / Math.max(1, canvas.clientWidth);
    pointer = { x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale };
    if (reducedMotion) draw();
  }

  function handlePointerLeave() {
    pointer = { x: -9999, y: -9999 };
    if (reducedMotion) draw();
  }

  function handleVisibility() {
    if (document.hidden) stopLoop();
    else start();
  }

  $: if (canvas) {
    if (active) start();
    else stopLoop();
  }

  $: if (canvas && strength >= 0) draw();

  onMount(() => {
    reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    observer = new ResizeObserver(resize);
    if (canvas) observer.observe(canvas);
    // Listen on the whole panel: the field sits under the chat content.
    const host = canvas?.parentElement;
    host?.addEventListener('pointermove', handlePointerMove);
    host?.addEventListener('pointerleave', handlePointerLeave);
    document.addEventListener('visibilitychange', handleVisibility);
    resize();
    start();
    return () => {
      host?.removeEventListener('pointermove', handlePointerMove);
      host?.removeEventListener('pointerleave', handlePointerLeave);
    };
  });

  onDestroy(() => {
    stopLoop();
    observer?.disconnect();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', handleVisibility);
  });
</script>

<canvas class="ai-field" bind:this={canvas} aria-hidden="true"></canvas>

<style>
  .ai-field {
    position: absolute;
    inset: 0;
    z-index: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    transition: opacity 400ms ease;
  }
</style>
