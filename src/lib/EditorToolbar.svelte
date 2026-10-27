<script>
  import { onMount } from 'svelte';
  import { cubicOut } from 'svelte/easing';
  import { scale } from 'svelte/transition';

  import { groups, toolDescriptions } from '#lib/editor-tools.js';

  const nonInvertedTools = new Set(['select', 'image', 'blackout', 'whiteout', 'measure', 'highlight']);
  /** Group primaries built from layered redesign artwork; every other tool shows its 50×50 icon from /redesign/tools. */
  const designIcons = new Set(['select', 'marker', 'textfield', 'protect', 'sign', 'measure', 'translate']);
  const lightSelectionTools = new Set(['blackout', 'whiteout']);


  /** @type {string} */
  export let activeTool = 'select';
  /** False while this toolbar's tab is in the background; it then ignores shortcuts. */
  export let active = true;
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

  /** @param {{ id: string; tools: { id: string; label: string; designIcon?: string }[] }} group */
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
    if (!active) return;
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
  <div class="editor-toolbar">
    {#each groups as group}
      <div class="tool-group" class:current={group.tools.some((tool) => tool.id === activeTool)} class:open={expandedGroup === group.id}>
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
         
          aria-label={selectedTool(group).label}
          aria-pressed={activeTool === groupSelections[group.id]}
          aria-describedby={toolbarTooltip?.label === selectedTool(group).label ? 'editor-toolbar-tooltip' : undefined}
          onmouseenter={(event) => scheduleSelectedToolTooltip(group, event.currentTarget)}
          onmouseleave={hideToolbarTooltip}
          onfocus={(event) => scheduleSelectedToolTooltip(group, event.currentTarget)}
          onblur={hideToolbarTooltip}
          onclick={() => selectTool(group.id, groupSelections[group.id])}
        >
          {#if designIcons.has(groupSelections[group.id])}
            {@const icon = groupSelections[group.id]}
            <span class={`design-icon design-icon-${icon}`} aria-hidden="true">
              {#if icon === 'select'}
                <img class="select-cursor" src="/redesign/vector595.svg" alt="" />
              {:else if icon === 'marker'}
                <img class="highlighter-base" src="/redesign/icon-highlighter.svg" alt="" />
                <img class="highlighter-tip" src="/redesign/vector647.svg" alt="" />
                <img class="highlighter-edge" src="/redesign/vector648.svg" alt="" />
              {:else if icon === 'textfield'}
                <span class="text-frame"></span>
                <img class="text-glyph" src="/redesign/icon-letter-text.svg" alt="" />
              {:else if icon === 'protect'}
                <img class="shield-fill" src="/redesign/vector603.svg" alt="" />
                <img class="shield-outline" src="/redesign/icon-shield-ban.svg" alt="" />
              {:else if icon === 'sign'}
                <img class="signature" src="/redesign/icon-signature.svg" alt="" />
              {:else if icon === 'measure'}
                <img class="pencil-ruler" src="/redesign/icon-pencil-ruler.svg" alt="" />
              {:else if icon === 'translate'}
                <img class="languages" src="/redesign/icon-languages.svg" alt="" />
              {/if}
            </span>
          {:else}
            <img
              class="tool-icon"
              class:preserve-color={nonInvertedTools.has(groupSelections[group.id])}
              src={`/redesign/tools/${selectedTool(group).designIcon ?? groupSelections[group.id]}.svg`}
              alt=""
            />
          {/if}
        </button>
        <button
          class:expanded={expandedGroup === group.id}
          class="expand-tool"
         
          aria-label={`Show ${group.tools[0].label} tools`}
          aria-expanded={expandedGroup === group.id}
          onmouseenter={(event) => scheduleToolbarTooltip({ id: 'menu', label: 'More Tools' }, event.currentTarget)}
          onmouseleave={hideToolbarTooltip}
          onfocus={(event) => scheduleToolbarTooltip({ id: 'menu', label: 'More Tools' }, event.currentTarget)}
          onblur={hideToolbarTooltip}
          onclick={(event) => toggleGroup(event, group.id)}
        >
          <img src="/redesign/vector596.svg" alt="" />
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
    bottom: 30px;
    left: 50%;
    transform: translateX(-50%);
  }

  .editor-toolbar {
    box-sizing: border-box;
    display: flex;
    align-items: center;
    height: 73px;
    padding: 8px 10px 8px 9px;
    border: 1px solid #dcdcdc;
    border-radius: 30px;
    background: #fff;
    box-shadow:
      inset 0 4px 18.4px rgba(255, 255, 255, 0.05),
      0 0 10px rgba(7, 7, 7, 0.03),
      0 4px 8px rgba(0, 0, 0, 0.1);
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
    width: 56px;
    height: 56px;
    transition: width 200ms cubic-bezier(0.22, 1, 0.36, 1);
  }

  .tool-group.current,
  .tool-group.open,
  .tool-group:hover,
  .tool-group:focus-within {
    width: 80px;
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
    border: 1px solid rgba(61, 60, 60, 0.08);
    border-radius: 23px;
    overflow: hidden;
    background: #ececec;
    transition: transform 150ms ease, background-color 160ms ease;
  }

  .primary-tool:hover {
    background: #e4e4e4;
  }

  .primary-tool:active {
    transform: scale(0.96);
  }

  .primary-tool.active,
  .primary-tool.active:hover {
    border-color: rgba(0, 0, 0, 0.08);
    background: #000;
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

  .primary-tool.active > img:not(.preserve-color) {
    filter: invert(1) hue-rotate(180deg);
  }

  .design-icon {
    position: absolute;
    inset: -1px;
    pointer-events: none;
  }

  .primary-tool .design-icon img {
    position: absolute;
    max-width: none;
    max-height: none;
  }

  .primary-tool.active .design-icon:not(.design-icon-select) {
    filter: invert(1) hue-rotate(180deg);
  }

  .primary-tool:not(.active) .design-icon-select img {
    filter: invert(1);
  }

  .select-cursor {
    top: 17.53px;
    left: 19.22px;
    width: 19.6886px;
    height: 23.0904px;
  }

  .highlighter-base {
    top: 16.92px;
    left: 10px;
    width: 28px;
    height: 28px;
  }

  .highlighter-tip,
  .highlighter-edge {
    transform: rotate(-2.51deg);
  }

  .highlighter-tip {
    top: 9.55px;
    left: 20.26px;
    width: 25.91px;
    height: 27.144px;
  }

  .highlighter-edge {
    top: 9.07px;
    left: 19.85px;
    width: 26.84px;
    height: 27.91px;
  }

  .primary-tool img.tool-icon {
    width: 50px;
    height: 50px;
    max-width: none;
    max-height: none;
  }

  .text-frame {
    position: absolute;
    top: 13px;
    left: 11px;
    box-sizing: border-box;
    width: 34px;
    height: 30px;
    border: 1.5px solid #9b9b9b;
    border-radius: 8px;
    background: #e8e8e8;
    box-shadow: 0 0 6.8px rgba(0, 0, 0, 0.15);
  }

  .text-glyph {
    top: 15px;
    left: 14px;
    width: 27px;
    height: 27px;
  }

  .shield-fill {
    top: 16.5px;
    left: 18.5px;
    width: 19px;
    height: 19px;
  }

  .shield-outline {
    top: 14px;
    left: 13px;
    width: 29px;
    height: 29px;
  }

  .signature {
    top: 12px;
    left: 12px;
    width: 31px;
    height: 31px;
  }

  .pencil-ruler {
    top: 13px;
    left: 13px;
    width: 29px;
    height: 29px;
  }

  .languages {
    top: 14px;
    left: 13px;
    width: 28px;
    height: 28px;
  }

  .expand-tool {
    position: absolute;
    z-index: 1;
    top: 0;
    right: 0;
    box-sizing: border-box;
    display: grid;
    place-items: center;
    width: 69px;
    height: 56px;
    padding: 0 0 0 45px;
    border: 1px solid #e5e5e5;
    border-radius: 23px;
    background: #f6f5f5;
    opacity: 0;
    pointer-events: none;
    transition: opacity 160ms ease, background-color 160ms ease;
  }

  .tool-group.current .expand-tool,
  .tool-group.open .expand-tool,
  .tool-group:hover .expand-tool,
  .tool-group:focus-within .expand-tool {
    opacity: 1;
    pointer-events: auto;
  }

  .expand-tool:hover {
    border-color: #dbdbdb;
    background: #eeeeee;
  }

  .expand-tool img {
    width: 12.5px;
    height: 6.76378px;
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
    .tool-group,
    .primary-tool,
    .expand-tool,
    .expand-tool img {
      transition: none;
    }
  }

  /* dark theme: generated by scripts/generate-dark-theme.mjs — do not edit */
  :global(:root[data-theme="dark"]) .editor-toolbar { border: 1px solid #212121; background: rgba(22, 22, 22, 0.96); box-shadow: inset 0 4px 18.4px rgba(0, 0, 0, 0.03),
      0 0 10px rgba(7, 7, 7, 0.12),
      0 4px 8px rgba(0, 0, 0, 0.3); }
  :global(:root[data-theme="dark"]) .primary-tool,
  :global(:root[data-theme="dark"]) .expand-tool,
  :global(:root[data-theme="dark"]) .tool-menu-item { border: 0; }
  :global(:root[data-theme="dark"]) .primary-tool { border: 1px solid rgba(255, 255, 255, 0.064); background: #111111; }
  :global(:root[data-theme="dark"]) .primary-tool:hover { background: #0f0f0f; }
  :global(:root[data-theme="dark"]) .primary-tool.active,
  :global(:root[data-theme="dark"]) .primary-tool.active:hover { border-color: rgba(255, 255, 255, 0.064); background: #ececec; }
  :global(:root[data-theme="dark"]) .primary-tool.active.light-selection { border-color: #313131; background: #101010; }
  :global(:root[data-theme="dark"]) .text-frame { border: 1.5px solid #3e3e3e; background: #101010; box-shadow: 0 0 6.8px rgba(0, 0, 0, 0.45); }
  :global(:root[data-theme="dark"]) .expand-tool { border: 1px solid rgba(255, 255, 255, 0.08); background: #131313; }
  :global(:root[data-theme="dark"]) .expand-tool:hover { border-color: #212121; background: #111111; }
  :global(:root[data-theme="dark"]) .tool-menu { border: 1px solid rgba(255, 255, 255, 0.144); background: rgba(24, 24, 24, 0.95); box-shadow: 0 7px 18px rgba(0, 0, 0, 0.33), 0 2px 5px rgba(0, 0, 0, 0.15); }
  :global(:root[data-theme="dark"]) .tool-menu-item { border: 1px solid transparent; background: transparent; color: rgba(255, 255, 255, 0.753); }
  :global(:root[data-theme="dark"]) .tool-menu-item.active { border-color: rgba(255, 255, 255, 0.064); background: rgba(22, 22, 22, 0.96); }
  :global(:root[data-theme="dark"]) .tool-menu-item:hover { color: rgba(255, 255, 255, 0.92); }
  :global(:root[data-theme="dark"]) .tool-menu-item kbd { border: 1px solid rgba(255, 255, 255, 0.04); background: rgba(255, 255, 255, 0.058); color: rgba(255, 255, 255, 0.16); }
  /* dark theme: end generated */

  /* dark theme: manual */
  /* Toolbar icons are drawn dark-on-light. On the dark toolbar every icon is the
     opposite of its light-mode treatment: light while unselected, dark on the
     white selected button. The colored image and highlight icons keep their colors. */
  :global(:root[data-theme="dark"]) .primary-tool img,
  :global(:root[data-theme="dark"]) .primary-tool .design-icon img { filter: none; }
  :global(:root[data-theme="dark"]) .primary-tool:not(.active) > img.tool-icon:not(.preserve-color),
  :global(:root[data-theme="dark"]) .primary-tool:not(.active) .design-icon:not(.design-icon-select) { filter: invert(1) hue-rotate(180deg); }
  /* Blackout and whiteout show the color they paint: a black and a white square, opposite each other.
     The black square gets a faint light edge so it reads on the dark toolbar. */
  :global(:root[data-theme="dark"]) .primary-tool.active.light-selection { border-color: #b8b8b8; background: #e9e9e9; }
  :global(:root[data-theme="dark"]) img[src$="/blackout.svg"] { filter: drop-shadow(0 0 0.6px rgba(255, 255, 255, 0.85)); }
  :global(:root[data-theme="dark"]) .primary-tool.active > img.tool-icon,
  :global(:root[data-theme="dark"]) .primary-tool.active .design-icon:not(.design-icon-select) { filter: none; }
  /* The select cursor is a white glyph: white while unselected, black when selected. */
  :global(:root[data-theme="dark"]) .primary-tool:not(.active) .design-icon-select img { filter: none; }
  :global(:root[data-theme="dark"]) .primary-tool.active .design-icon-select img { filter: invert(1); }
  /* Design icons are inverted as a whole, so their drawn parts keep the light colors. */
  :global(:root[data-theme="dark"]) .design-icon .text-frame { border-color: #9b9b9b; background: #e8e8e8; box-shadow: 0 0 6.8px rgba(0, 0, 0, 0.15); }
  :global(:root[data-theme="dark"]) .expand-tool img { filter: brightness(0) invert(1) opacity(0.78); }

</style>
