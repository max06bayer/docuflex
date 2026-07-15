<script>
  /** @type {{ page: number; left: number; top: number; width: number; height: number }[]} */
  export let pageFrames = [];
  /** @type {any[]} */
  export let annotations = [];

  /** @param {number} page */
  function annotationsForPage(page) {
    return annotations.filter((annotation) => Number(annotation?.page) === page);
  }

  /** @param {any[]} points @param {number} width @param {number} height */
  function normalizedPath(points, width, height) {
    return points.map((point, index) => `${index ? 'L' : 'M'} ${Number(point.x || 0) * width} ${Number(point.y || 0) * height}`).join(' ');
  }

  /** @param {any[]} style @param {number} offset @param {number[]} fallback @param {number} alpha */
  function styleRgba(style, offset, fallback, alpha) {
    return `rgba(${[0, 1, 2].map((index) => Math.round(Math.max(0, Math.min(1, Number(style[offset + index] ?? fallback[index]))) * 255)).join(',')},${Math.max(0, Math.min(1, alpha))})`;
  }

  /** @param {any} annotation @param {{ width: number; height: number }} frame */
  function roundedTrianglePath(annotation, frame) {
    const x = Number(annotation.x || 0) * frame.width;
    const y = Number(annotation.y || 0) * frame.height;
    const width = Number(annotation.width || 0) * frame.width;
    const height = Number(annotation.height || 0) * frame.height;
    const points = [{ x: x + width / 2, y }, { x: x + width, y: y + height }, { x, y: y + height }];
    const radius = Math.max(0, Math.min(Number(annotation.radiusX || 0) * frame.width, width * 0.45, height * 0.45));
    if (radius < 0.01) return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y} L ${points[2].x} ${points[2].y} Z`;
    const toward = /** @param {{ x: number; y: number }} from @param {{ x: number; y: number }} to */ (from, to) => {
      const length = Math.max(0.001, Math.hypot(to.x - from.x, to.y - from.y));
      const distance = Math.min(radius, length * 0.42);
      return { x: from.x + (to.x - from.x) * distance / length, y: from.y + (to.y - from.y) * distance / length };
    };
    const incoming = points.map((point, index) => toward(point, points[(index + 2) % 3]));
    const outgoing = points.map((point, index) => toward(point, points[(index + 1) % 3]));
    return `M ${outgoing[0].x} ${outgoing[0].y} L ${incoming[1].x} ${incoming[1].y} Q ${points[1].x} ${points[1].y} ${outgoing[1].x} ${outgoing[1].y} L ${incoming[2].x} ${incoming[2].y} Q ${points[2].x} ${points[2].y} ${outgoing[2].x} ${outgoing[2].y} L ${incoming[0].x} ${incoming[0].y} Q ${points[0].x} ${points[0].y} ${outgoing[0].x} ${outgoing[0].y} Z`;
  }

  /** @param {any} annotation */
  function objectStyle(annotation) {
    const style = Array.isArray(annotation.color) ? annotation.color : [];
    if (style.length < 12) return '';
    const fill = Number(style[8]) >= 0.5 && Number(style[9]) >= 0.5 ? styleRgba(style, 0, [1, 0.302, 0.333], Number(style[21] ?? 1)) : 'transparent';
    const stroke = Number(style[10]) >= 0.5 && Number(style[11]) >= 0.5 ? styleRgba(style, 3, [0.871, 0.208, 0.259], Number(style[22] ?? 1)) : 'transparent';
    const shadow = Number(style[12]) >= 0.5 && Number(style[13]) >= 0.5
      ? `drop-shadow(${Number(style[16] ?? 0)}px ${Number(style[17] ?? 3)}px ${Number(style[15] ?? 6)}px rgba(0,0,0,${Math.max(0, Math.min(1, Number(style[14] ?? 0.25)))}))`
      : 'none';
    return `opacity:${Math.max(0, Math.min(1, Number(style[6] ?? 1)))};filter:${shadow};--object-fill:${fill};--object-stroke:${stroke};--object-stroke-width:${Math.max(0, Number(style[7] ?? 1.35))}px`;
  }
</script>

<div class="overlay-root" aria-hidden="true">
  {#each pageFrames as frame (frame.page)}
    <svg
      class="page-overlay"
      style:left={`${frame.left}px`}
      style:top={`${frame.top}px`}
      style:width={`${frame.width}px`}
      style:height={`${frame.height}px`}
      viewBox={`0 0 ${frame.width} ${frame.height}`}
      preserveAspectRatio="none"
    >
      {#each annotationsForPage(frame.page) as annotation}
        {@const x = Number(annotation.x || 0) * frame.width}
        {@const y = Number(annotation.y || 0) * frame.height}
        {@const width = Number(annotation.width || 0) * frame.width}
        {@const height = Number(annotation.height || 0) * frame.height}
        {@const centerX = x + width / 2}
        {@const centerY = y + height / 2}
        {#if annotation.type === 'highlight'}
          <rect class="text-highlight" x={x} y={y} {width} {height} rx={Math.min(2, height * 0.12)} />
        {:else if annotation.type === 'marker'}
          {@const path = normalizedPath(annotation.points ?? [], frame.width, frame.height)}
          <path class="marker-edge" d={path} />
          <path class="marker-ink" d={path} />
        {:else if annotation.type === 'pen'}
          {@const path = normalizedPath(annotation.points ?? [], frame.width, frame.height)}
          <path class="pen-edge" d={path} />
          <path class="pen-ink" d={path} />
        {:else}
          <g transform={`rotate(${Number(annotation.rotation || 0)} ${centerX} ${centerY})`} style={objectStyle(annotation)}>
            {#if Array.isArray(annotation.color) && Number(annotation.color[18]) >= 0.5 && Number(annotation.color[19]) >= 0.5 && !['line', 'arrow', 'check', 'cross', 'textfield'].includes(annotation.type)}
              <foreignObject {x} {y} {width} {height} class="object-background-blur">
                <div
                  class:circle={annotation.type === 'circle'}
                  class:triangle={annotation.type === 'triangle'}
                  style:--object-corner={`${Math.max(0, Number(annotation.radiusX || 0) * frame.width)}px`}
                  style:--object-blur={`${Math.max(0, Number(annotation.color[20] ?? 8))}px`}
                ></div>
              </foreignObject>
            {/if}
            {#if annotation.type === 'image' || annotation.type === 'signature'}
              <image
                href={annotation.imageData}
                {x}
                {y}
                {width}
                {height}
                preserveAspectRatio="none"
                style:clip-path={`inset(0 round ${Math.max(0, Number(annotation.radiusX || 0) * frame.width)}px)`}
              />
              {#if annotation.type === 'image' && Array.isArray(annotation.color) && Number(annotation.color[10]) >= 0.5 && Number(annotation.color[11]) >= 0.5}
                <rect class="image-stroke" {x} {y} {width} {height} rx={Math.max(0, Number(annotation.radiusX || 0) * frame.width)} />
              {/if}
            {:else if annotation.type === 'watermark'}
              <text
                class="watermark"
                x={centerX}
                y={centerY}
                font-size={Math.max(14, Math.min(height * 0.45, width / Math.max(1, String(annotation.text ?? '').length * 0.58)))}
              >{annotation.text ?? ''}</text>
            {:else if annotation.type === 'rectangle'}
              <rect class="filled-shape" {x} {y} {width} {height} rx={Math.max(0, Number(annotation.radiusX || 0) * frame.width)} />
            {:else if annotation.type === 'circle'}
              <ellipse class="filled-shape" cx={centerX} cy={centerY} rx={width / 2} ry={height / 2} />
            {:else if annotation.type === 'triangle'}
              <path class="filled-shape" d={roundedTrianglePath(annotation, frame)} />
            {:else if annotation.type === 'check'}
              <polyline class="symbol-shape" points={`${x + width * 0.08},${y + height * 0.54} ${x + width * 0.38},${y + height * 0.82} ${x + width * 0.92},${y + height * 0.16}`} />
            {:else if annotation.type === 'cross'}
              <line class="symbol-shape" x1={x + width * 0.14} y1={y + height * 0.14} x2={x + width * 0.86} y2={y + height * 0.86} />
              <line class="symbol-shape" x1={x + width * 0.86} y1={y + height * 0.14} x2={x + width * 0.14} y2={y + height * 0.86} />
            {:else if annotation.type === 'line' || annotation.type === 'arrow'}
              <line class="linear-shape" x1={x} y1={centerY} x2={x + width} y2={centerY} />
              {#if annotation.type === 'arrow'}
                {@const headWidth = Math.min(16, Math.max(8, width * 0.16))}
                {@const headHeight = Math.min(7, Math.max(4, width * 0.07))}
                <polyline class="linear-shape" points={`${x + width - headWidth},${centerY - headHeight} ${x + width},${centerY} ${x + width - headWidth},${centerY + headHeight}`} />
              {/if}
            {:else if annotation.type === 'textfield'}
              <foreignObject {x} {y} width={Math.max(1, width)} height={Math.max(height, 20)}>
                <div class="text-field">{annotation.text ?? ''}</div>
              </foreignObject>
            {/if}
          </g>
        {/if}
      {/each}
    </svg>
  {/each}
</div>

<style>
  .overlay-root {
    position: absolute;
    z-index: 3;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
  }

  .page-overlay {
    position: absolute;
    overflow: hidden;
    pointer-events: none;
  }

  path,
  polyline,
  line {
    fill: none;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .text-highlight {
    fill: #ffe43b;
    mix-blend-mode: multiply;
  }

  .marker-edge {
    stroke: #f4cd19;
    stroke-width: 20px;
    opacity: 0.13;
  }

  .marker-ink {
    stroke: #ffe43b;
    stroke-width: 16px;
    opacity: 0.34;
  }

  .pen-edge {
    stroke: #8d0613;
    stroke-width: 3.4px;
    opacity: 0.15;
  }

  .pen-ink {
    stroke: #e21d32;
    stroke-width: 2.05px;
    opacity: 0.94;
  }

  .filled-shape {
    fill: var(--object-fill, #ff4d55);
    stroke: var(--object-stroke, #de3542);
    stroke-width: var(--object-stroke-width, 1.35px);
    stroke-linejoin: round;
  }

  .symbol-shape {
    stroke: var(--object-stroke, #ff4d55);
    stroke-width: var(--object-stroke-width, 1.7px);
  }

  .linear-shape {
    stroke: var(--object-stroke, #ff4d55);
    stroke-width: var(--object-stroke-width, 1.4px);
  }

  .image-stroke {
    fill: none;
    stroke: var(--object-stroke, #de3542);
    stroke-width: var(--object-stroke-width, 1.35px);
  }

  .object-background-blur,
  .object-background-blur > div {
    pointer-events: none;
  }

  .object-background-blur > div {
    width: 100%;
    height: 100%;
    border-radius: var(--object-corner, 0);
    backdrop-filter: blur(var(--object-blur, 8px));
    -webkit-backdrop-filter: blur(var(--object-blur, 8px));
  }

  .object-background-blur > div.circle { border-radius: 50%; }
  .object-background-blur > div.triangle { clip-path: polygon(50% 0, 100% 100%, 0 100%); }

  .text-field {
    color: #171717;
    font: 400 16px/1.2 Helvetica, Arial, sans-serif;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  .watermark {
    fill: #505761;
    font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-weight: 700;
    letter-spacing: 0.02em;
    text-anchor: middle;
    dominant-baseline: central;
    opacity: 0.17;
    mix-blend-mode: multiply;
  }
</style>
