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
          <g transform={`rotate(${Number(annotation.rotation || 0)} ${centerX} ${centerY})`}>
            {#if annotation.type === 'rectangle'}
              <rect class="filled-shape" {x} {y} {width} {height} />
            {:else if annotation.type === 'circle'}
              <ellipse class="filled-shape" cx={centerX} cy={centerY} rx={width / 2} ry={height / 2} />
            {:else if annotation.type === 'triangle'}
              <polygon class="filled-shape" points={`${centerX},${y} ${x + width},${y + height} ${x},${y + height}`} />
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
    fill: #ff4d55;
    stroke: #de3542;
    stroke-width: 1.35px;
    stroke-linejoin: round;
  }

  .symbol-shape {
    stroke: #ff4d55;
    stroke-width: 1.7px;
  }

  .linear-shape {
    stroke: #ff4d55;
    stroke-width: 1.4px;
  }

  .text-field {
    color: #171717;
    font: 400 16px/1.2 Helvetica, Arial, sans-serif;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }
</style>
