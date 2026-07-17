<script>
  import { onMount } from 'svelte';
  import { cubicOut } from 'svelte/easing';
  import { scale } from 'svelte/transition';

  const groups = [
    {
      id: 'select',
      primary: 'select',
      tools: [
        { id: 'select', label: 'Select', shortcut: 'V' },
        { id: 'pan', label: 'Pan', shortcut: 'P' },
        { id: 'zoom', label: 'Zoom', shortcut: 'Z' }
      ]
    },
    {
      id: 'drawing',
      primary: 'marker',
      tools: [
        { id: 'marker', label: 'Marker', shortcut: 'M' },
        { id: 'pen', label: 'Pen', shortcut: 'N' },
        { id: 'eraser', label: 'Eraser', shortcut: 'E' }
      ]
    },
    {
      id: 'shapes',
      primary: 'triangle',
      tools: [
        { id: 'triangle', label: 'Triangle', shortcut: 'T' },
        { id: 'rectangle', label: 'Rectangle', shortcut: 'R' },
        { id: 'circle', label: 'Circle', shortcut: 'C' },
        { id: 'check', label: 'Check', shortcut: 'K' },
        { id: 'cross', label: 'Cross', shortcut: 'X' },
        { id: 'arrow', label: 'Arrow', shortcut: 'A' },
        { id: 'line', label: 'Line', shortcut: 'L' }
      ]
    },
    {
      id: 'text',
      primary: 'textfield',
      tools: [
        { id: 'textfield', label: 'Text Field', shortcut: 'F' },
        { id: 'edit', label: 'Edit Text', shortcut: 'D' },
        { id: 'highlight', label: 'Highlight', shortcut: 'H' },
        { id: 'crossout', label: 'Cross Out', shortcut: 'Q' },
        { id: 'underline', label: 'Underline', shortcut: 'U' },
        { id: 'image', label: 'Image', shortcut: 'I' }
      ]
    },
    {
      id: 'protect',
      primary: 'protect',
      tools: [
        { id: 'protect', label: 'Protect', shortcut: 'G' },
        { id: 'blackout', label: 'Blackout', shortcut: 'B' },
        { id: 'whiteout', label: 'Whiteout', shortcut: 'W' }
      ]
    },
    {
      id: 'sign',
      primary: 'sign',
      tools: [
        { id: 'sign', label: 'Sign', shortcut: 'S' },
        { id: 'checkbox', label: 'Checkbox', shortcut: 'J' },
        { id: 'input', label: 'Input', shortcut: 'O' }
      ]
    },
    {
      id: 'measure',
      primary: 'measure',
      tools: [
        { id: 'measure', label: 'Measure', shortcut: 'Y' },
        { id: 'crop', label: 'Crop', shortcut: '1' }
      ]
    },
    {
      id: 'document',
      primary: 'ocr',
      tools: [
        { id: 'ocr', smallIcon: 'orc', label: 'OCR', shortcut: '3' },
        { id: 'search', label: 'Find', shortcut: '4' },
        { id: 'watermark', label: 'Watermark', shortcut: '5' }
      ]
    }
  ];

  const nonInvertedTools = new Set(['select', 'image', 'blackout', 'whiteout', 'measure', 'highlight']);
  const lightSelectionTools = new Set(['blackout', 'whiteout']);
  /** @type {Record<string, string>} */
  const toolDescriptions = {
    select: 'Select and inspect objects or text.', pan: 'Move around the document canvas.', zoom: 'Zoom into an area of the document.',
    marker: 'Draw a translucent marker stroke.', pen: 'Draw a freehand pen stroke.', eraser: 'Erase drawings and annotations.',
    triangle: 'Add a triangle shape.', rectangle: 'Add a rectangle shape.', circle: 'Add a circle shape.', check: 'Add a check mark.', cross: 'Add a cross mark.', arrow: 'Add an arrow.', line: 'Add a straight line.',
    textfield: 'Add a new text field.', edit: 'Edit existing PDF text.', highlight: 'Highlight selected text.', crossout: 'Strike through selected text.', underline: 'Underline selected text.', image: 'Place an image in the PDF.',
    protect: 'Protect the PDF with a password.', blackout: 'Permanently cover content in black.', whiteout: 'Permanently cover content in white.',
    sign: 'Add a saved or new signature.', checkbox: 'Add a checkbox field.', input: 'Add a fillable input field.',
    measure: 'Measure a distance on the page.', crop: 'Crop the visible page area.',
    ocr: 'Recognize text in scanned pages.', search: 'Find text in the document.', watermark: 'Add a watermark to every page.'
  };

  /** @type {string} */
  export let activeTool = 'select';
  let groupSelections = Object.fromEntries(groups.map((group) => [group.id, group.primary]));
  /** @type {string | null} */
  let expandedGroup = null;
  /** @type {{ label: string; description: string; x: number; y: number; placement: 'above' | 'right' | 'left' } | null} */
  let toolbarTooltip = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let toolbarTooltipTimer;

  $: {
    const activeGroup = groups.find((group) => group.tools.some((tool) => tool.id === activeTool));
    if (activeGroup && groupSelections[activeGroup.id] !== activeTool) {
      groupSelections = { ...groupSelections, [activeGroup.id]: activeTool };
    }
  }

  /** @param {string} groupId @param {string} tool */
  function selectTool(groupId, tool) {
    hideToolbarTooltip();
    activeTool = tool;
    groupSelections = { ...groupSelections, [groupId]: tool };
    expandedGroup = null;
  }

  /** @param {{ id: string; tools: { id: string; label: string }[] }} group */
  function selectedTool(group) {
    return group.tools.find((tool) => tool.id === groupSelections[group.id]) ?? group.tools[0];
  }

  /** @param {MouseEvent} event @param {string} groupId */
  function toggleGroup(event, groupId) {
    hideToolbarTooltip();
    event.stopPropagation();
    expandedGroup = expandedGroup === groupId ? null : groupId;
  }

  /** @param {{ id: string; label: string }} tool @param {HTMLElement} element @param {'above' | 'side'} [placement] */
  function scheduleToolbarTooltip(tool, element, placement = 'above') {
    clearTimeout(toolbarTooltipTimer);
    toolbarTooltip = null;
    toolbarTooltipTimer = setTimeout(() => {
      const rect = element.getBoundingClientRect();
      const uiScale = rect.width / Math.max(1, element.offsetWidth);
      const scale = Number.isFinite(uiScale) && uiScale > 0 ? uiScale : 1;
      const tooltipWidth = 250 * scale;
      const center = Math.max(tooltipWidth / 2 + 10, Math.min(window.innerWidth - tooltipWidth / 2 - 10, rect.left + rect.width / 2));
      const showRight = rect.right + 8 + tooltipWidth <= window.innerWidth - 10;
      toolbarTooltip = {
        label: tool.label,
        description: tool.id === 'menu' ? 'Show the other tools in this group.' : (toolDescriptions[tool.id] ?? `Use the ${tool.label} tool.`),
        x: (placement === 'side' ? (showRight ? rect.right + 8 : rect.left - 8) : center) / scale,
        y: (placement === 'side' ? rect.top + rect.height / 2 : rect.top - 7) / scale,
        placement: placement === 'side' ? (showRight ? 'right' : 'left') : 'above'
      };
    }, 680);
  }

  function hideToolbarTooltip() {
    clearTimeout(toolbarTooltipTimer);
    toolbarTooltip = null;
  }

  /** @param {{ id: string; tools: { id: string; label: string }[] }} group @param {HTMLElement} element */
  function scheduleSelectedToolTooltip(group, element) {
    scheduleToolbarTooltip(selectedTool(group), element);
  }

  /** @param {KeyboardEvent} event */
  function handleToolShortcut(event) {
    const target = event.target;
    if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
    if (target instanceof HTMLElement && (target.matches('input, textarea, select') || target.isContentEditable)) return;

    const shortcut = event.key.toUpperCase();
    const group = groups.find((candidate) => candidate.tools.some((tool) => tool.shortcut === shortcut));
    const tool = group?.tools.find((candidate) => candidate.shortcut === shortcut);
    if (!group || !tool) return;

    event.preventDefault();
    selectTool(group.id, tool.id);
  }

  onMount(() => {
    function closeMenus() {
      expandedGroup = null;
      hideToolbarTooltip();
    }

    document.addEventListener('click', closeMenus);
    window.addEventListener('keydown', handleToolShortcut);
    window.addEventListener('scroll', hideToolbarTooltip, true);
    window.addEventListener('resize', hideToolbarTooltip);
    return () => {
      document.removeEventListener('click', closeMenus);
      window.removeEventListener('keydown', handleToolShortcut);
      window.removeEventListener('scroll', hideToolbarTooltip, true);
      window.removeEventListener('resize', hideToolbarTooltip);
      clearTimeout(toolbarTooltipTimer);
    };
  });
</script>

<div class="editor-toolbar-wrap" aria-label="Editor toolbar">
  <div class="editor-toolbar" style="corner-shape: squircle;">
    {#each groups as group}
      <div class="tool-group">
        {#if expandedGroup === group.id}
          <div
            class="tool-menu"
            transition:scale={{ duration: 125, easing: cubicOut, start: 0.94, opacity: 0 }}
          >
            {#each group.tools as tool}
              <button
                class:active={activeTool === tool.id}
                class="tool-menu-item"
                data-tool={tool.id}
                aria-pressed={activeTool === tool.id}
                aria-describedby={toolbarTooltip?.label === tool.label ? 'editor-toolbar-tooltip' : undefined}
                onmouseenter={(event) => scheduleToolbarTooltip(tool, event.currentTarget, 'side')}
                onmouseleave={hideToolbarTooltip}
                onfocus={(event) => scheduleToolbarTooltip(tool, event.currentTarget, 'side')}
                onblur={hideToolbarTooltip}
                onclick={() => selectTool(group.id, tool.id)}
              >
                <img src={`/toolbar/small/${tool.smallIcon ?? tool.id}.svg`} alt="" />
                <span>{tool.label}</span>
                <kbd>{tool.shortcut}</kbd>
              </button>
            {/each}
          </div>
        {/if}

        <button
          class:active={activeTool === groupSelections[group.id]}
          class:light-selection={lightSelectionTools.has(groupSelections[group.id])}
          class="primary-tool"
          style="corner-shape: squircle;"
          aria-label={selectedTool(group).label}
          aria-pressed={activeTool === groupSelections[group.id]}
          aria-describedby={toolbarTooltip?.label === selectedTool(group).label ? 'editor-toolbar-tooltip' : undefined}
          onmouseenter={(event) => scheduleSelectedToolTooltip(group, event.currentTarget)}
          onmouseleave={hideToolbarTooltip}
          onfocus={(event) => scheduleSelectedToolTooltip(group, event.currentTarget)}
          onblur={hideToolbarTooltip}
          onclick={() => selectTool(group.id, groupSelections[group.id])}
        >
          <img
            class:preserve-color={nonInvertedTools.has(groupSelections[group.id])}
            src={`/toolbar/big/${groupSelections[group.id]}.webp`}
            alt=""
          />
        </button>
        <button
          class:expanded={expandedGroup === group.id}
          class="expand-tool"
          style="corner-shape: squircle;"
          aria-label={`Show ${group.tools[0].label} tools`}
          aria-expanded={expandedGroup === group.id}
          onmouseenter={(event) => scheduleToolbarTooltip({ id: 'menu', label: 'More Tools' }, event.currentTarget)}
          onmouseleave={hideToolbarTooltip}
          onfocus={(event) => scheduleToolbarTooltip({ id: 'menu', label: 'More Tools' }, event.currentTarget)}
          onblur={hideToolbarTooltip}
          onclick={(event) => toggleGroup(event, group.id)}
        >
          <img src="/toolbar/expand.svg" alt="" />
        </button>
      </div>
    {/each}
  </div>
</div>
{#if toolbarTooltip}
  <div
    id="editor-toolbar-tooltip"
    class="toolbar-tooltip"
    class:side={toolbarTooltip.placement === 'right'}
    class:side-left={toolbarTooltip.placement === 'left'}
    role="tooltip"
    style:left={`${toolbarTooltip.x}px`}
    style:top={`${toolbarTooltip.y}px`}
  >
    <strong>{toolbarTooltip.label} Tool</strong>
    <span>{toolbarTooltip.description}</span>
  </div>
{/if}

<style>
  .editor-toolbar-wrap {
    position: absolute;
    z-index: 10;
    bottom: 34px;
    left: 50%;
    transform: translateX(-50%);
  }

  .editor-toolbar {
    box-sizing: border-box;
    display: flex;
    align-items: center;
    height: 73px;
    padding: 8px 8px;
    border: 1px solid #d1d1d1;
    border-radius: 20px;
    background: #fff;
    box-shadow: 0 13px 28px rgba(0, 0, 0, 0.22), 0 3px 8px rgba(0, 0, 0, 0.1);
  }

  .toolbar-tooltip {
    position: fixed;
    z-index: 1200;
    display: grid;
    gap: 3px;
    box-sizing: border-box;
    width: 250px;
    padding: 10px 12px 12px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 9px;
    background: #222222;
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.2), 0 2px 7px rgba(0, 0, 0, 0.12);
    color: #ffffff;
    font-family: Geist, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 17px;
    font-weight: 400;
    line-height: 1.2;
    letter-spacing: -0.15px;
    transform: translate(-50%, -100%);
    transform-origin: center bottom;
    pointer-events: none;
    animation: toolbar-tooltip-in 150ms cubic-bezier(0.22, 1, 0.36, 1) both;
    -webkit-font-smoothing: antialiased;
  }

  .toolbar-tooltip strong { color: #ffffff; font: inherit; }
  .toolbar-tooltip span { color: #aaaaaa; }

  .toolbar-tooltip.side {
    transform: translateY(-50%);
    transform-origin: left center;
  }

  .toolbar-tooltip.side-left {
    transform: translate(-100%, -50%);
    transform-origin: right center;
  }

  @keyframes toolbar-tooltip-in {
    from { opacity: 0; transform: translate(-50%, -100%) scale(0.96); }
    to { opacity: 1; transform: translate(-50%, -100%) scale(1); }
  }

  .toolbar-tooltip.side,
  .toolbar-tooltip.side-left {
    animation-name: toolbar-side-tooltip-in;
  }

  @keyframes toolbar-side-tooltip-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .tool-group {
    position: relative;
    width: 80px;
    height: 56px;
  }

  .tool-group + .tool-group {
    margin-left: 10px;
  }

  button {
    font: inherit;
  }

  .primary-tool,
  .expand-tool,
  .tool-menu-item {
    border: 0;
    cursor: pointer;
  }

  .primary-tool {
    position: absolute;
    z-index: 2;
    top: 0;
    left: 0;
    box-sizing: border-box;
    display: grid;
    place-items: center;
    width: 56px;
    height: 56px;
    padding: 0;
    border: 1px solid #e4e4e4;
    border-radius: 14px;
    overflow: hidden;
    background: #f8f8f8;
    transition: transform 150ms ease;
  }

  .primary-tool:active {
    transform: scale(0.96);
  }

  .primary-tool.active {
    border-color: #171717;
    background: #171717;
  }

  .primary-tool.active.light-selection {
    border-color: #b8b8b8;
    background: #e9e9e9;
  }

  .primary-tool img {
    display: block;
    width: auto;
    height: auto;
    max-width: 90%;
    max-height: 90%;
  }

  .primary-tool.active img:not(.preserve-color) {
    filter: invert(1) hue-rotate(180deg);
  }

  .expand-tool {
    position: absolute;
    z-index: 1;
    top: 0;
    right: 0;
    box-sizing: border-box;
    display: grid;
    place-items: center;
    width: 51px;
    height: 56px;
    padding: 0 0 0 25px;
    border: 1px solid #e4e4e4;
    border-radius: 14px;
    background: #f8f8f8;
  }

  .expand-tool:hover {
    border-color: #dbdbdb;
    background: #eeeeee;
  }

  .expand-tool img {
    width: 14px;
    height: 7px;
    transition: transform 160ms ease;
  }

  .expand-tool.expanded img {
    transform: rotate(180deg);
  }

  .tool-menu {
    position: absolute;
    right: 0;
    bottom: calc(100% + 13px);
    width: 204px;
    padding: 5px;
    border: 1px solid rgba(0, 0, 0, 0.18);
    border-radius: 15px;
    background: rgba(255, 255, 255, 0.78);
    box-shadow: 0 7px 18px rgba(0, 0, 0, 0.11), 0 2px 5px rgba(0, 0, 0, 0.05);
    backdrop-filter: blur(18px);
    -webkit-backdrop-filter: blur(18px);
    transform-origin: bottom right;
  }

  .tool-menu-item {
    display: grid;
    grid-template-columns: 28px 1fr 28px;
    align-items: center;
    width: 100%;
    height: 40px;
    padding: 0 7px;
    border: 1px solid transparent;
    border-radius: 9px;
    background: transparent;
    color: #3f3f3f;
    font-size: 18px;
    text-align: left;
  }

  .tool-menu-item.active {
    border-color: rgba(0, 0, 0, 0.08);
    background: rgba(234, 234, 234, 0.574);
  }

  .tool-menu-item:hover {
    color: #000;
  }

  .tool-menu-item img {
    display: block;
    transform: translateX(-2px);
    transition: filter 140ms ease;
  }

  .tool-menu-item[data-tool='select'] img {
    transform: translateX(1px);
  }

  .tool-menu-item[data-tool='rectangle'] img {
    transform: translateX(-7px);
  }

  .tool-menu-item[data-tool='edit'] img {
    transform: translateX(-3px);
  }

  .tool-menu-item[data-tool='crossout'] img,
  .tool-menu-item[data-tool='underline'] img,
  .tool-menu-item[data-tool='blackout'] img,
  .tool-menu-item[data-tool='whiteout'] img {
    transform: translateX(-9px);
  }

  .tool-menu-item[data-tool='check'] img,
  .tool-menu-item[data-tool='cross'] img,
  .tool-menu-item[data-tool='arrow'] img,
  .tool-menu-item[data-tool='line'] img {
    transform: translateX(2px);
  }

  .tool-menu-item:hover img {
    filter: brightness(0.55);
  }

  .tool-menu-item kbd {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border: 1px solid rgba(0, 0, 0, 0.04);
    border-radius: 7px;
    background: rgba(0, 0, 0, 0.045);
    color: rgba(0, 0, 0, 0.16);
    font-family: inherit;
    font-size: 18px;
  }

  @media (max-width: 1260px) {
    .editor-toolbar {
      transform: scale(0.78);
      transform-origin: bottom center;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .primary-tool,
    .expand-tool img {
      transition: none;
    }
  }
</style>
