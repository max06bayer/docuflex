<script>
  import { onDestroy, onMount, tick } from 'svelte';
  import { cubicOut } from 'svelte/easing';
  import { fade, fly, slide } from 'svelte/transition';
  import { renderMarkdown } from '$lib/ai-markdown.js';

  /**
   * AI chat docked next to the document. The model (through /api/ai/chat)
   * answers and asks for tool calls; this window runs the agent loop and the
   * calls go through /api/ai/tool, the same code path as the MCP server, so
   * every edit shows up live and can be undone.
   */

  export let open = false;
  /** @type {{ available: boolean; model?: string; fallbackModel?: string; tools?: { name: string; title: string; readOnly: boolean; needsApproval: boolean }[] } | null} */
  export let status = null;
  /** @type {() => any} */
  export let getContext = () => ({});
  export let hasDocument = false;
  /** @type {() => void} */
  export let onClose = () => {};
  /** Lets the top bar show that the agent is working while the panel is closed. */
  /** @type {(busy: boolean) => void} */
  export let onBusyChange = () => {};

  /** @typedef {'streaming' | 'running' | 'approval' | 'done' | 'error' | 'denied' | 'cancelled'} ToolStatus */
  /** @typedef {{ x: number; y: number; width: number; height: number }} Region */
  /** @typedef {{ id: number; task: string; page: number; region: Region | null; status: 'running' | 'done' | 'error' | 'cancelled'; steps: number; current: string; summary: string; objects: number[] }} Helper */
  /** @typedef {{ id: string; name: string; rawArgs: string; args: Record<string, any>; status: ToolStatus; result: string; image: string | null; expanded: boolean; helpers?: Helper[] }} ToolEntry */
  /** @typedef {{ id: number; role: 'user'; text: string; quote: { text: string; page: number | null } | null; images: string[] }} UserEntry */
  /** @typedef {{ id: number; role: 'assistant'; text: string; reasoning: string; thinkingStartedAt: number | null; thinkingMs: number; showReasoning: boolean; tools: ToolEntry[]; streaming: boolean }} AssistantEntry */
  /** @typedef {{ id: number; role: 'error' | 'note'; text: string }} ErrorEntry */
  /** @typedef {UserEntry | AssistantEntry | ErrorEntry} Entry */

  const MAX_STEPS = 32;
  /** More calls than this in one model turn are skipped: the model is flooding. */
  const MAX_CALLS_PER_TURN = 12;
  const MAX_HELPERS = 4;
  const HELPER_STEPS = 12;
  const HELPER_CALLS_PER_TURN = 8;
  /** Helpers may read anything; these edit and are limited to the helper's page and region. */
  const HELPER_EDIT_TOOLS = new Set(['add_text', 'add_math', 'add_shape', 'add_line', 'add_image', 'draw', 'mark_text', 'add_comment']);
  const HELPER_READ_TOOLS = new Set(['get_document_info', 'get_page_text', 'search_text', 'render_page', 'list_objects', 'list_comments', 'list_form_fields', 'measure_text']);
  const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
  /** Older page renders are dropped from what the model sees, to keep requests small. */
  const KEEP_IMAGE_MESSAGES = 2;

  const TOOL_ICONS = /** @type {Record<string, string>} */ ({
    list_documents: '/pdficon.svg', open_document: '/pdficon.svg', switch_document: '/pdficon.svg', close_document: '/pdficon.svg', get_document_info: '/pdficon.svg',
    unlock_document: '/lock.svg', set_password: '/lock.svg', save_document: '/save.svg', extract_pages: '/save.svg',
    get_page_text: '/toolbar/small/search.svg', search_text: '/toolbar/small/search.svg', render_page: '/eye.svg',
    add_text: '/toolbar/small/textfield.svg', add_shape: '/toolbar/small/rectangle.svg', add_line: '/toolbar/small/line.svg', add_image: '/toolbar/small/image.svg',
    draw: '/toolbar/small/pen.svg', mark_text: '/toolbar/small/highlight.svg', set_watermark: '/toolbar/small/watermark.svg',
    list_objects: '/toolbar/small/select.svg', update_object: '/toolbar/small/select.svg', delete_object: '/toolbar/small/eraser.svg',
    replace_text: '/toolbar/small/edit.svg', list_comments: '/comments.svg', add_comment: '/comments.svg', reply_to_comment: '/pages/reply.svg', delete_comment: '/comments.svg',
    list_form_fields: '/toolbar/small/input.svg', fill_form_field: '/toolbar/small/checkbox.svg', add_form_field: '/toolbar/small/input.svg',
    rotate_pages: '/pages/rotate-ccw.svg', delete_pages: '/pages/trash.svg', reorder_pages: '/pages/copy.svg', insert_pdf: '/pages/clipboard-plus.svg',
    measure_text: '/toolbar/small/measure.svg', add_math: '/toolbar/small/textfield.svg', insert_blank_page: '/bigplus.svg', remember: '/brain.svg', forget: '/brain.svg', delegate: '/brain.svg', rasterize_pages: '/color.svg', run_ocr: '/toolbar/small/orc.svg', undo: '/arrowleft.svg', redo: '/arrowright.svg', set_view: '/toolbar/small/zoom.svg'
  });

  /** @type {Entry[]} */
  let entries = [];
  /** Conversation in the chat-completions format, without the system prompt. */
  /** @type {any[]} */
  let history = [];
  let draft = '';
  /** @type {string[]} */
  let attachments = [];
  /** Text the person selected in the document; sent along with the next message. */
  /** @type {{ text: string; page: number | null } | null} */
  let selectionQuote = null;
  /** A selection already sent or dismissed; it stays selected in the document, so don't pick it up again. */
  let usedSelection = '';
  let busy = false;
  /** @type {AbortController | null} */
  let controller = null;
  /** @type {Map<string, (allowed: boolean) => void>} */
  const approvals = new Map();
  let usage = { cost: 0, tokens: 0 };
  /** The saved chat this conversation belongs to; created with the first message. */
  /** @type {{ id: string; createdAt: string; title: string } | null} */
  let chat = null;
  /** @type {{ id: string; title: string; document: string | null; updatedAt: string }[]} */
  let savedChats = [];
  let showHistory = false;
  /** Where the newest exchange starts in history; it is compacted before the next message. */
  /** @type {number | null} */
  let uncompactedFrom = null;
  let nextId = 1;
  let now = Date.now();
  /** @type {any} */
  let liveContext = {};

  /** @type {HTMLElement | undefined} */
  let panel;
  /** @type {HTMLDivElement | undefined} */
  let scroller;
  /** @type {HTMLDivElement | undefined} */
  let scrollContent;
  /** @type {ResizeObserver | undefined} */
  let contentObserver;
  /** @type {HTMLTextAreaElement | undefined} */
  let input;
  /** @type {HTMLInputElement | undefined} */
  let fileInput;
  let stickToBottom = true;
  let dragging = false;
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let clock;

  $: toolInfo = new Map((status?.tools ?? []).map((tool) => [tool.name, tool]));
  $: modelLabel = modelName(status?.model ?? '');
  $: onBusyChange(busy);
  $: if (open) void onOpen();
  $: activeDocument = liveContext?.active ?? null;
  $: suggestions = hasDocument
    ? [
        { label: 'Summarize this document', prompt: 'Summarize this document in a few bullet points with page references.' },
        { label: 'Highlight all dates and amounts', prompt: 'Highlight every date and every money amount in this document.' },
        { label: 'Check this page for typos', prompt: 'Check the current page for typos and fix them in place.' },
        { label: 'Fill out the form', prompt: 'List the form fields in this document and help me fill them out.' }
      ]
    : [
        { label: 'What can you do?', prompt: 'What can you do in Docuflex? Keep it short.' },
        { label: 'Open a PDF from my Downloads', prompt: 'Open the most recent PDF I mention from ~/Downloads. Ask me for the file name first.' }
      ];

  /** @param {string} id */
  function modelName(id) {
    const known = /** @type {Record<string, string>} */ ({
      'xiaomi/mimo-v2.6-flash': 'MiMo V2.6 Flash',
      'xiaomi/mimo-v2.6-pro': 'MiMo V2.6 Pro',
      'google/gemini-3-flash-preview': 'Gemini 3 Flash'
    });
    return known[id] ?? id.split('/').pop() ?? id;
  }

  async function onOpen() {
    refreshContext();
    void loadChatList();
    await tick();
    scrollToBottom(true);
    input?.focus();
  }

  function refreshContext() {
    try {
      liveContext = getContext() ?? {};
    } catch {
      liveContext = {};
    }
  }

  function refresh() {
    entries = entries;
    if (stickToBottom) void tick().then(() => scrollToBottom());
  }

  function scrollToBottom(force = false) {
    if (!scroller) return;
    if (force) stickToBottom = true;
    scroller.scrollTop = scroller.scrollHeight;
  }

  function handleScroll() {
    if (!scroller) return;
    stickToBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
  }

  function autosize() {
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  }

  /** @param {Record<string, any>} args @param {string} name */
  function summarizeArgs(name, args) {
    if (!args || typeof args !== 'object') return '';
    if (name === 'delegate') return `${Array.isArray(args.tasks) ? args.tasks.length : 0} parallel tasks`;
    /** @param {string} text @param {number} [max] */
    const short = (text, max = 42) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
    /** @type {string[]} */
    const parts = [];
    if (args.page !== undefined) parts.push(`Page ${args.page}`);
    if (Array.isArray(args.pages)) parts.push(`${args.pages.length === 1 ? 'Page' : 'Pages'} ${short(args.pages.join(', '), 24)}`);
    if (Array.isArray(args.order)) parts.push(`Order ${short(args.order.join(', '), 24)}`);
    if (typeof args.type === 'string' && name !== 'add_form_field') parts.push(args.type[0].toUpperCase() + args.type.slice(1));
    for (const key of ['query', 'find', 'quote', 'text', 'name']) {
      if (typeof args[key] === 'string' && args[key]) {
        parts.push(`“${short(args[key].replace(/\s+/g, ' '))}”`);
        break;
      }
    }
    if (typeof args.replace === 'string') parts.push(`→ “${short(args.replace.replace(/\s+/g, ' '), 30)}”`);
    if (typeof args.path === 'string') parts.push(args.path.split('/').pop() ?? args.path);
    if (args.objectId !== undefined) parts.push(`Object ${args.objectId}`);
    if (args.commentId !== undefined) parts.push(`Comment ${args.commentId}`);
    if (args.documentId !== undefined) parts.push(`Document ${args.documentId}`);
    if (args.degrees !== undefined) parts.push(`${args.degrees}°`);
    if (args.zoom !== undefined) parts.push(`${args.zoom}×`);
    if (typeof args.password === 'string') parts.push(args.password ? '••••••' : 'Remove');
    return parts.join(' · ');
  }

  /** Arguments as shown when a tool row is expanded; passwords stay hidden. @param {Record<string, any>} args */
  function displayArgs(args) {
    const copy = { ...args };
    if (typeof copy.password === 'string' && copy.password) copy.password = '••••••';
    if (typeof copy.dataUrl === 'string') copy.dataUrl = `${copy.dataUrl.slice(0, 32)}…`;
    return JSON.stringify(copy, null, 2);
  }

  /** @param {string} text */
  function prettyResult(text) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  }

  /** @param {ToolEntry} tool */
  function approvalText(tool) {
    const file = typeof tool.args.path === 'string' ? tool.args.path : '';
    if (tool.name === 'save_document') return `Save the document to ${file || 'a file'}?${tool.args.mode === 'flattened' ? ' (flattened print copy)' : ''} An existing file there is replaced.`;
    if (tool.name === 'extract_pages') return `Save ${Array.isArray(tool.args.pages) ? `pages ${tool.args.pages.join(', ')}` : 'pages'} to ${file || 'a new file'}? An existing file there is replaced.`;
    if (tool.name === 'close_document') return 'Close this document? Unsaved changes are lost.';
    return 'Allow this action?';
  }

  /** @param {any[]} messages */
  function trimImages(messages) {
    let kept = 0;
    return [...messages].reverse().map((message) => {
      if (!Array.isArray(message.content) || !message.content.some((/** @type {any} */ part) => part.type === 'image_url')) return message;
      kept += 1;
      if (kept <= KEEP_IMAGE_MESSAGES) return message;
      return {
        ...message,
        content: message.content.map((/** @type {any} */ part) => (part.type === 'image_url' ? { type: 'text', text: '[earlier image removed]' } : part))
      };
    }).reverse();
  }

  /**
   * Streams one model turn into the entry and returns the tool calls it asked for.
   * @param {AssistantEntry} entry @param {AbortSignal} signal
   */
  async function streamTurn(entry, signal) {
    refreshContext();
    const response = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: trimImages(history), context: liveContext }),
      signal
    });
    /** @type {{ id: string; name: string; arguments: string; entry: ToolEntry | null }[]} */
    const calls = [];
    await readEvents(response, (chunk) => {
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) return;
      if (delta.reasoning) {
        entry.thinkingStartedAt ??= Date.now();
        entry.reasoning += delta.reasoning;
      }
      if (delta.content) {
        if (entry.thinkingStartedAt && !entry.thinkingMs) entry.thinkingMs = Date.now() - entry.thinkingStartedAt;
        entry.text += delta.content;
      }
      for (const part of delta.tool_calls ?? []) {
        const index = part.index ?? calls.length;
        const call = (calls[index] ??= { id: '', name: '', arguments: '', entry: null });
        if (part.id) call.id = part.id;
        if (part.function?.name && !call.name) call.name = part.function.name;
        if (part.function?.arguments) call.arguments += part.function.arguments;
        if (call.name && !call.entry) {
          if (entry.thinkingStartedAt && !entry.thinkingMs) entry.thinkingMs = Date.now() - entry.thinkingStartedAt;
          call.entry = { id: call.id || `call_${nextId++}`, name: call.name, rawArgs: '', args: {}, status: 'streaming', result: '', image: null, expanded: false };
          entry.tools.push(call.entry);
        }
        if (call.entry) {
          call.entry.rawArgs = call.arguments;
          try {
            call.entry.args = JSON.parse(call.arguments || '{}');
          } catch {
            // Still streaming.
          }
        }
      }
      refresh();
    });
    if (entry.thinkingStartedAt && !entry.thinkingMs) entry.thinkingMs = Date.now() - entry.thinkingStartedAt;
    return calls.filter(Boolean).map((call) => {
      const tool = /** @type {ToolEntry} */ (call.entry);
      tool.id = call.id || tool.id;
      return tool;
    });
  }

  /**
   * Reads OpenRouter's server-sent events and hands each chunk to onChunk.
   * @param {Response} response @param {(chunk: any) => void} onChunk
   */
  async function readEvents(response, onChunk) {
    if (!response.ok || !response.body) {
      const details = await response.json().catch(() => null);
      throw new Error(details?.error || `The AI service answered with HTTP ${response.status}.`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        /** @type {any} */
        let chunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk.error) throw new Error(chunk.error.message || 'The AI service failed.');
        if (chunk.usage) usage = { cost: usage.cost + (chunk.usage.cost ?? 0), tokens: usage.tokens + (chunk.usage.total_tokens ?? 0) };
        onChunk(chunk);
      }
    }
  }

  /**
   * Runs a tool in the window through the local server.
   * @param {string} name @param {Record<string, any>} args @param {string} agent
   * @returns {Promise<{ text: string; image: string | null; isError: boolean }>}
   */
  async function callTool(name, args, agent) {
    const response = await fetch('/api/ai/tool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, args, context: liveContext, agent })
    });
    const result = await response.json();
    const text = (result.content ?? []).filter((/** @type {any} */ part) => part.type === 'text').map((/** @type {any} */ part) => part.text).join('\n');
    const image = (result.content ?? []).find((/** @type {any} */ part) => part.type === 'image');
    return { text: text || (image ? 'Rendered.' : 'Done.'), image: image ? `data:${image.mimeType};base64,${image.data}` : null, isError: Boolean(result.isError) };
  }

  /** @param {any} value @returns {Region | null} */
  function parseRegion(value) {
    if (!value || typeof value !== 'object') return null;
    const region = { x: Number(value.x), y: Number(value.y), width: Number(value.width), height: Number(value.height) };
    return Object.values(region).every(Number.isFinite) && region.width > 0 && region.height > 0 ? region : null;
  }

  /** @param {Region} a @param {Region} b */
  function regionsOverlap(a, b) {
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  }

  /**
   * Runs helper agents in parallel, each confined to its page and region.
   * @param {ToolEntry} tool @param {Record<string, any>} args @param {AbortSignal} signal
   * @returns {Promise<{ text: string; image: string | null }>}
   */
  async function runDelegate(tool, args, signal) {
    const tasks = Array.isArray(args.tasks) ? args.tasks : [];
    /** @param {string} text */
    const fail = (text) => {
      tool.status = 'error';
      tool.result = text;
      return { text: `Error: ${text}`, image: null };
    };
    if (!tasks.length) return fail('give at least one task.');
    if (tasks.length > MAX_HELPERS) return fail(`at most ${MAX_HELPERS} tasks at once. Split the work into several delegate calls.`);
    const pageCount = Number(liveContext?.active?.pageCount) || Infinity;
    /** @type {Helper[]} */
    const helpers = [];
    for (const [index, task] of tasks.entries()) {
      const page = Number(task?.page);
      if (typeof task?.task !== 'string' || !task.task.trim()) return fail(`task ${index + 1} has no instructions.`);
      if (!Number.isInteger(page) || page < 1 || page > pageCount) return fail(`task ${index + 1} has an invalid page ${task?.page}.`);
      if (task.region !== undefined && !parseRegion(task.region)) return fail(`task ${index + 1} has an invalid region; give x, y, width, height in points.`);
      helpers.push({ id: nextId++, task: task.task.trim(), page, region: parseRegion(task.region), status: 'running', steps: 0, current: '', summary: '', objects: [] });
    }
    for (let first = 0; first < helpers.length; first += 1) {
      for (let second = first + 1; second < helpers.length; second += 1) {
        const a = helpers[first];
        const b = helpers[second];
        if (a.page !== b.page) continue;
        if (!a.region || !b.region || regionsOverlap(a.region, b.region)) {
          return fail(`tasks ${first + 1} and ${second + 1} would work on the same part of page ${a.page}. Give tasks on the same page regions that do not overlap.`);
        }
      }
    }
    tool.helpers = helpers;
    tool.status = 'running';
    refresh();
    await Promise.all(helpers.map((helper) => runHelper(helper, signal)));
    const failed = helpers.filter((helper) => helper.status !== 'done').length;
    tool.status = failed === helpers.length ? 'error' : 'done';
    tool.result = helpers.map((helper, index) => `${index + 1}. Page ${helper.page}: ${helper.summary}`).join('\n');
    refresh();
    return {
      text: JSON.stringify({
        results: helpers.map((helper) => ({ task: helper.task.slice(0, 120), page: helper.page, region: helper.region, status: helper.status, summary: helper.summary, objectsCreated: helper.objects }))
      }, null, 2),
      image: null
    };
  }

  /**
   * Checks a helper's call against its page, region and objects. Returns a
   * refusal for the model, or the arguments to run (sizes fitted to the region).
   * @param {string} name @param {Record<string, any>} args @param {Helper} helper @param {Set<number>} owned
   * @returns {{ refusal: string } | { args: Record<string, any> }}
   */
  function scopeHelperCall(name, args, helper, owned) {
    if (HELPER_READ_TOOLS.has(name)) return { args };
    const region = helper.region;
    const area = region ? `x ${region.x}–${region.x + region.width}, y ${region.y}–${region.y + region.height} on page ${helper.page}` : `page ${helper.page}`;
    /** @param {number} x @param {number} y */
    const inside = (x, y) => !region || (x >= region.x - 2 && x <= region.x + region.width + 2 && y >= region.y - 2 && y <= region.y + region.height + 2);
    /** @param {number} x @param {number} y */
    const outside = (x, y) => ({ refusal: `Refused: (${Math.round(x)}, ${Math.round(y)}) is outside your area (${area}). Stay inside it.` });

    if (HELPER_EDIT_TOOLS.has(name)) {
      if (Number(args.page) !== helper.page) return { refusal: `Refused: you only work on page ${helper.page}.` };
      const next = { ...args };
      /** @type {[number, number][]} */
      let points = [];
      if (name === 'add_line') points = [[Number(args.x1), Number(args.y1)], [Number(args.x2), Number(args.y2)]];
      else if (name === 'draw') points = (Array.isArray(args.points) ? args.points : []).map((/** @type {any} */ point) => /** @type {[number, number]} */ ([Number(point.x), Number(point.y)]));
      else if (name === 'mark_text') {
        if (region && !Array.isArray(args.rects)) return { refusal: 'Refused: with an area, mark text by rects inside your area (get positions from get_page_text or search_text), not by query.' };
        points = (args.rects ?? []).flatMap((/** @type {any} */ rect) => /** @type {[number, number][]} */ ([[Number(rect.x), Number(rect.y)], [Number(rect.x) + Number(rect.width), Number(rect.y) + Number(rect.height)]]));
      } else if (args.x !== undefined && args.y !== undefined) {
        points = [[Number(args.x), Number(args.y)]];
        if (args.width !== undefined && args.height !== undefined) points.push([Number(args.x) + Number(args.width), Number(args.y) + Number(args.height)]);
      }
      for (const [x, y] of points) if (!inside(x, y)) return outside(x, y);
      // Keep text and formulas from running past the right edge of the area.
      if (region && args.x !== undefined) {
        const room = region.x + region.width - Number(args.x);
        if (name === 'add_text' && args.width === undefined) next.width = room;
        if (name === 'add_math' && !(Number(args.maxWidth) > 0)) next.maxWidth = room;
      }
      return { args: next };
    }

    if (name === 'update_object' || name === 'delete_object') {
      if (args.allOnPage !== undefined) return { refusal: 'Refused: helpers cannot clear pages. Delete your own objects by id.' };
      const ids = [...(Array.isArray(args.objectIds) ? args.objectIds : []), ...(args.objectId !== undefined ? [args.objectId] : [])].map(Number);
      const foreign = ids.filter((id) => !owned.has(id));
      if (foreign.length) return { refusal: `Refused: ${foreign.length > 1 ? 'objects' : 'object'} ${foreign.join(', ')} ${foreign.length > 1 ? 'were' : 'was'} not created by you. You may only change your own objects: ${[...owned].join(', ') || 'none yet'}.` };
      if (args.x !== undefined && args.y !== undefined && !inside(Number(args.x), Number(args.y))) return outside(Number(args.x), Number(args.y));
      return { args };
    }
    return { refusal: `Refused: helpers cannot use ${name}. Only the main agent can; mention it in your summary.` };
  }

  /**
   * One helper agent: its own short conversation, limited tools and area.
   * @param {Helper} helper @param {AbortSignal} signal
   */
  async function runHelper(helper, signal) {
    const agent = `helper-${helper.id}`;
    /** @type {Set<number>} */
    const owned = new Set();
    /** @type {any[]} */
    let messages = [{ role: 'user', content: helper.task }];
    try {
      for (let step = 0; step < HELPER_STEPS; step += 1) {
        if (signal.aborted) throw new Error('Stopped.');
        helper.current = 'Thinking';
        refresh();
        const response = await fetch('/api/ai/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: trimImages(messages), context: liveContext, subagent: { page: helper.page, region: helper.region } }),
          signal
        });
        let text = '';
        /** @type {{ id: string; name: string; arguments: string }[]} */
        const calls = [];
        await readEvents(response, (chunk) => {
          const delta = chunk.choices?.[0]?.delta;
          if (!delta) return;
          if (delta.content) text += delta.content;
          for (const part of delta.tool_calls ?? []) {
            const call = (calls[part.index ?? calls.length] ??= { id: '', name: '', arguments: '' });
            if (part.id) call.id = part.id;
            if (part.function?.name && !call.name) call.name = part.function.name;
            if (part.function?.arguments) call.arguments += part.function.arguments;
          }
        });
        const toolCalls = calls.filter(Boolean).map((call, index) => ({ ...call, id: call.id || `${agent}_${step}_${index}` }));
        messages = [...messages, {
          role: 'assistant',
          content: text || null,
          ...(toolCalls.length ? { tool_calls: toolCalls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments || '{}' } })) } : {})
        }];
        if (!toolCalls.length) {
          helper.status = 'done';
          helper.summary = text.trim() || 'Done.';
          return;
        }
        /** @type {string[]} */
        const images = [];
        for (const [index, call] of toolCalls.entries()) {
          if (index >= HELPER_CALLS_PER_TURN || signal.aborted) {
            messages = [...messages, { role: 'tool', tool_call_id: call.id, content: signal.aborted ? 'Cancelled.' : `Skipped: at most ${HELPER_CALLS_PER_TURN} calls per turn.` }];
            continue;
          }
          /** @type {Record<string, any>} */
          let args;
          try {
            args = JSON.parse(call.arguments || '{}');
          } catch {
            messages = [...messages, { role: 'tool', tool_call_id: call.id, content: 'Error: the arguments were not valid JSON.' }];
            continue;
          }
          helper.steps += 1;
          helper.current = toolInfo.get(call.name)?.title ?? call.name;
          refresh();
          const scoped = scopeHelperCall(call.name, args, helper, owned);
          /** @type {{ text: string; image: string | null; isError: boolean }} */
          let result;
          if ('refusal' in scoped) {
            result = { text: scoped.refusal, image: null, isError: true };
          } else {
            result = await callTool(call.name, scoped.args, agent);
            if (!result.isError) {
              try {
                const value = JSON.parse(result.text);
                const id = Number(value?.objectId);
                if (Number.isFinite(id) && call.name !== 'update_object') {
                  owned.add(id);
                  if (!helper.objects.includes(id)) helper.objects = [...helper.objects, id];
                }
                if (call.name === 'delete_object' && Array.isArray(value?.deleted)) helper.objects = helper.objects.filter((objectId) => !value.deleted.includes(objectId));
              } catch {
                // Not JSON.
              }
            } else {
              result = { ...result, text: `Error: ${result.text}` };
            }
          }
          messages = [...messages, { role: 'tool', tool_call_id: call.id, content: result.text }];
          if (result.image) images.push(result.image);
        }
        if (images.length) {
          messages = [...messages, { role: 'user', content: [{ type: 'text', text: 'Rendered image:' }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))] }];
        }
      }
      helper.status = helper.objects.length ? 'done' : 'error';
      helper.summary = `Stopped after ${HELPER_STEPS} steps${helper.objects.length ? `; created objects ${helper.objects.join(', ')}` : ' without finishing'}.`;
    } catch (error) {
      helper.status = signal.aborted ? 'cancelled' : 'error';
      helper.summary = signal.aborted ? 'Stopped.' : error instanceof Error ? error.message : String(error);
    } finally {
      helper.current = '';
      refresh();
    }
  }

  /**
   * Runs one tool call and returns what the model gets back.
   * @param {ToolEntry} tool @param {AbortSignal} signal
   * @returns {Promise<{ text: string; image: string | null }>}
   */
  async function runTool(tool, signal) {
    let args;
    try {
      args = JSON.parse(tool.rawArgs || '{}');
    } catch {
      tool.status = 'error';
      tool.result = 'The arguments were not valid JSON.';
      return { text: `Error: the arguments for ${tool.name} were not valid JSON. Send them again.`, image: null };
    }
    tool.args = args;

    if (toolInfo.get(tool.name)?.needsApproval) {
      tool.status = 'approval';
      refresh();
      const allowed = await new Promise((resolve) => approvals.set(tool.id, resolve));
      approvals.delete(tool.id);
      if (!allowed) {
        tool.status = signal.aborted ? 'cancelled' : 'denied';
        tool.result = 'Not allowed.';
        return { text: 'The person did not allow this action. Do not try it again unless they ask for it.', image: null };
      }
    }

    tool.status = 'running';
    refresh();
    try {
      if (tool.name === 'delegate') return await runDelegate(tool, args, signal);
      const result = await callTool(tool.name, args, 'chat');
      tool.result = result.text;
      tool.image = result.image;
      tool.status = result.isError ? 'error' : 'done';
      return { text: result.isError ? `Error: ${result.text}` : result.text, image: result.image };
    } catch (error) {
      tool.status = 'error';
      tool.result = error instanceof Error ? error.message : String(error);
      return { text: `Error: ${tool.result}`, image: null };
    } finally {
      refresh();
    }
  }

  async function runAgent() {
    busy = true;
    controller = new AbortController();
    const { signal } = controller;
    try {
      for (let step = 0; step < MAX_STEPS; step += 1) {
        /** @type {AssistantEntry} */
        const entry = { id: nextId++, role: 'assistant', text: '', reasoning: '', thinkingStartedAt: null, thinkingMs: 0, showReasoning: false, tools: [], streaming: true };
        entries = [...entries, entry];
        refresh();
        let tools;
        try {
          tools = await streamTurn(entry, signal);
        } finally {
          entry.streaming = false;
          refresh();
        }

        history = [...history, {
          role: 'assistant',
          content: entry.text || null,
          ...(tools.length ? { tool_calls: tools.map((tool) => ({ id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.rawArgs || '{}' } })) } : {})
        }];
        if (!tools.length) {
          if (!entry.text.trim()) entries = entries.filter((item) => item !== entry);
          return;
        }

        /** @type {string[]} */
        const images = [];
        for (const [index, tool] of tools.entries()) {
          if (index >= MAX_CALLS_PER_TURN) {
            tool.status = 'cancelled';
            tool.result = 'Skipped: too many calls in one turn.';
            history = [...history, { role: 'tool', tool_call_id: tool.id, content: `Skipped: you sent ${tools.length} calls in one turn; only the first ${MAX_CALLS_PER_TURN} ran. Look at their results before sending more.` }];
            continue;
          }
          if (signal.aborted) {
            tool.status = 'cancelled';
            history = [...history, { role: 'tool', tool_call_id: tool.id, content: 'Cancelled: the person stopped the agent.' }];
            continue;
          }
          const result = await runTool(tool, signal);
          history = [...history, { role: 'tool', tool_call_id: tool.id, content: result.text }];
          if (result.image) images.push(result.image);
        }
        refresh();
        if (images.length) {
          history = [...history, {
            role: 'user',
            content: [
              { type: 'text', text: `Image${images.length > 1 ? 's' : ''} from render_page, in call order:` },
              ...images.map((url) => ({ type: 'image_url', image_url: { url } }))
            ]
          }];
        }
        if (signal.aborted) return;
      }
      entries = [...entries, { id: nextId++, role: 'error', text: `Stopped after ${MAX_STEPS} steps. Send a message to continue.` }];
    } catch (error) {
      if (signal.aborted) return;
      entries = [...entries, { id: nextId++, role: 'error', text: error instanceof Error ? error.message : String(error) }];
    } finally {
      if (signal.aborted) entries = [...entries, { id: nextId++, role: 'note', text: 'Stopped' }];
      busy = false;
      controller = null;
      for (const resolve of approvals.values()) resolve(false);
      approvals.clear();
      // A stop during streaming leaves calls that never ran.
      for (const item of entries) {
        if (item.role !== 'assistant') continue;
        for (const tool of item.tools) if (tool.status === 'streaming' || tool.status === 'running' || tool.status === 'approval') tool.status = 'cancelled';
      }
      refresh();
      refreshContext();
      void saveChat();
    }
  }

  /** @param {string} [text] */
  async function send(text = draft) {
    const message = text.trim();
    if ((!message && !attachments.length) || busy || !status?.available) return;
    compactHistory();
    const quote = selectionQuote;
    const images = attachments;
    let prompt = message || 'Look at the attached image.';
    if (quote) prompt = `Selected text in the document${quote.page ? ` (page ${quote.page})` : ''}:\n"""\n${quote.text}\n"""\n\n${prompt}`;
    history = [...history, {
      role: 'user',
      content: images.length ? [{ type: 'text', text: prompt }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))] : prompt
    }];
    uncompactedFrom = history.length;
    chat ??= { id: crypto.randomUUID(), createdAt: new Date().toISOString(), title: (message || 'Image').replace(/\s+/g, ' ').slice(0, 80) };
    showHistory = false;
    entries = [...entries, { id: nextId++, role: 'user', text: message, quote, images }];
    draft = '';
    attachments = [];
    if (selectionQuote) usedSelection = selectionQuote.text;
    selectionQuote = null;
    await tick();
    autosize();
    scrollToBottom(true);
    await runAgent();
  }

  async function loadChatList() {
    try {
      const response = await fetch('/api/ai/chats', { cache: 'no-store' });
      if (response.ok) savedChats = (await response.json()).chats ?? [];
    } catch {
      // Keep the last list.
    }
  }

  /** Saves the conversation without page images (they are large and can be rendered again). */
  async function saveChat() {
    if (!chat || !entries.length) return;
    const storedEntries = entries.map((entry) => {
      if (entry.role === 'user') return { ...entry, images: [] };
      if (entry.role === 'assistant') return { ...entry, streaming: false, tools: entry.tools.map((tool) => ({ ...tool, image: null, expanded: false })) };
      return entry;
    });
    const storedHistory = history.map((message) => Array.isArray(message.content)
      ? { ...message, content: message.content.map((/** @type {any} */ part) => (part.type === 'image_url' ? { type: 'text', text: '[image not kept]' } : part)) }
      : message);
    try {
      await fetch('/api/ai/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: chat.id,
          title: chat.title,
          createdAt: chat.createdAt,
          document: liveContext?.active?.name ?? null,
          entries: storedEntries,
          history: storedHistory,
          uncompactedFrom
        })
      });
      void loadChatList();
    } catch {
      // Saving is best effort; the chat stays open.
    }
  }

  /** @param {string} id */
  async function resumeChat(id) {
    if (busy) return;
    try {
      const response = await fetch(`/api/ai/chats?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (!response.ok) throw new Error();
      const stored = await response.json();
      entries = stored.entries ?? [];
      history = stored.history ?? [];
      uncompactedFrom = typeof stored.uncompactedFrom === 'number' ? stored.uncompactedFrom : null;
      chat = { id: stored.id, createdAt: stored.createdAt, title: stored.title };
      nextId = Math.max(0, ...entries.map((entry) => entry.id)) + 1;
      usage = { cost: 0, tokens: 0 };
      showHistory = false;
      await tick();
      scrollToBottom(true);
      input?.focus();
    } catch {
      savedChats = savedChats.filter((entry) => entry.id !== id);
    }
  }

  /** @param {string} id */
  async function deleteSavedChat(id) {
    savedChats = savedChats.filter((entry) => entry.id !== id);
    if (chat?.id === id) newChat();
    await fetch(`/api/ai/chats?id=${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => null);
  }

  /** @param {string} iso */
  function relativeTime(iso) {
    const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
    if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
    if (seconds < 7 * 86_400) return `${Math.round(seconds / 86_400)} d ago`;
    return new Date(iso).toLocaleDateString();
  }

  /**
   * Replaces the last finished exchange's tool calls, results and page images
   * with a short log of what ran, keeping the final answer word for word.
   * The model sees what it did without carrying every result forward.
   */
  function compactHistory() {
    if (uncompactedFrom === null || uncompactedFrom >= history.length) return;
    const start = uncompactedFrom;
    uncompactedFrom = null;
    const turn = history.slice(start);
    /** @type {Map<string, string>} */
    const results = new Map(turn.filter((message) => message.role === 'tool').map((message) => [message.tool_call_id, String(message.content ?? '')]));
    /** @type {string[]} */
    const log = [];
    for (const message of turn) {
      if (message.role !== 'assistant' || !message.tool_calls) continue;
      for (const call of message.tool_calls) {
        /** @type {Record<string, any>} */
        let args = {};
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch {
          // Shown without details.
        }
        log.push(`- ${call.function.name} ${summarizeArgs(call.function.name, args)} → ${outcome(results.get(call.id) ?? '')}`.replace(/\s+→/, ' →'));
      }
    }
    const answer = [...turn].reverse().find((message) => message.role === 'assistant' && message.content)?.content ?? '';
    if (!log.length) return;
    history = [...history.slice(0, start), {
      role: 'assistant',
      content: `[Compacted log of the tool calls I made for this request]\n${log.slice(-40).join('\n')}${answer ? `\n\n${answer}` : ''}`
    }];
  }

  /** One line for what a tool result said. @param {string} text */
  function outcome(text) {
    if (/^(Error|Not run|Paused|Wait|Skipped|Cancelled|The person did not allow)/.test(text)) return text.split('\n')[0].slice(0, 160);
    try {
      const value = JSON.parse(text);
      if (value?.duplicate) return `already existed as object ${value.objectId}`;
      if (value?.objectId !== undefined) return `ok, object ${value.objectId}${value.page ? ` on page ${value.page}` : ''}`;
      if (Array.isArray(value?.deleted)) return `deleted ${value.deleted.join(', ') || 'nothing'}`;
      if (value?.insertedPage) return `ok, new page ${value.insertedPage}`;
      if (Array.isArray(value?.results)) return value.results.map((/** @type {any} */ result) => `page ${result.page}: ${result.status}, objects ${(result.objectsCreated ?? []).join(', ') || 'none'}`).join('; ');
    } catch {
      // Not JSON.
    }
    return 'ok';
  }

  function retry() {
    if (busy) return;
    entries = entries.filter((item, index) => !(item.role === 'error' && index === entries.length - 1));
    void runAgent();
  }

  function stop() {
    controller?.abort();
    for (const resolve of approvals.values()) resolve(false);
  }

  function newChat() {
    if (busy) stop();
    entries = [];
    history = [];
    uncompactedFrom = null;
    chat = null;
    showHistory = false;
    usage = { cost: 0, tokens: 0 };
    draft = '';
    attachments = [];
    selectionQuote = null;
    void tick().then(() => {
      autosize();
      input?.focus();
    });
  }

  /** @param {string} id @param {boolean} allowed */
  function answerApproval(id, allowed) {
    approvals.get(id)?.(allowed);
  }

  /** @param {KeyboardEvent} event */
  function handleKeydown(event) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void send();
    } else if (event.key === 'Escape' && busy) {
      event.preventDefault();
      event.stopPropagation();
      stop();
    }
  }

  /** @param {File[]} files */
  async function addImages(files) {
    for (const file of files) {
      if (!file.type.startsWith('image/') || file.size > MAX_IMAGE_BYTES || attachments.length >= 4) continue;
      const url = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => resolve('');
        reader.readAsDataURL(file);
      });
      if (url) attachments = [...attachments, url];
    }
  }

  /** @param {ClipboardEvent} event */
  function handlePaste(event) {
    const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith('image/'));
    if (!files.length) return;
    event.preventDefault();
    void addImages(files);
  }

  /** @param {DragEvent} event */
  function handleDrop(event) {
    dragging = false;
    const files = [...(event.dataTransfer?.files ?? [])].filter((file) => file.type.startsWith('image/'));
    if (!files.length) return;
    event.preventDefault();
    void addImages(files);
  }

  /** Remembers text selected in the document so it can go along with the next message. */
  function handleSelectionChange() {
    if (!open) return;
    const selection = window.getSelection();
    const text = selection?.toString().trim().slice(0, 4000);
    if (!text) usedSelection = '';
    if (!text || !selection?.anchorNode || text === usedSelection || text === selectionQuote?.text) return;
    const element = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode.parentElement;
    if (!element || panel?.contains(element) || !element.closest('.pdf-workspace')) return;
    const pageElement = element.closest('.pdf-page');
    const pages = [...document.querySelectorAll('.pdf-workspace:not(.editor-inactive) .pdf-page')];
    const index = pageElement ? pages.indexOf(pageElement) : -1;
    selectionQuote = { text, page: index >= 0 ? index + 1 : null };
  }

  /** @param {number} ms */
  function duration(ms) {
    const seconds = Math.max(1, Math.round(ms / 1000));
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }

  /** @param {ToolStatus} toolStatus */
  function statusLabel(toolStatus) {
    return { streaming: 'Preparing', running: 'Running', approval: 'Needs approval', done: 'Done', error: 'Failed', denied: 'Not allowed', cancelled: 'Cancelled' }[toolStatus];
  }

  onMount(() => {
    document.addEventListener('selectionchange', handleSelectionChange);
    // Rows grow after they render (slide-ins, page images), so keep following the bottom.
    contentObserver = new ResizeObserver(() => {
      if (stickToBottom) scrollToBottom();
    });
    if (scrollContent) contentObserver.observe(scrollContent);
    let ticks = 0;
    clock = setInterval(() => {
      if (busy) now = Date.now();
      // Keep the document / page line under the input current.
      if (open && (ticks += 1) % 4 === 0) refreshContext();
    }, 250);
  });

  onDestroy(() => {
    if (typeof document !== 'undefined') document.removeEventListener('selectionchange', handleSelectionChange);
    clearInterval(clock);
    contentObserver?.disconnect();
    controller?.abort();
  });
</script>

<aside
  class="ai-panel"
  class:open
  class:dragging
  aria-label="AI Chat"
  aria-hidden={!open}
  inert={!open}
  bind:this={panel}
  ondragover={(event) => { if ([...(event.dataTransfer?.items ?? [])].some((item) => item.type.startsWith('image/'))) { event.preventDefault(); dragging = true; } }}
  ondragleave={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) dragging = false; }}
  ondrop={handleDrop}
>
  <header class="ai-header">
    <img src="/brain.svg" alt="" />
    <h2>{showHistory ? 'Chats' : 'AI Chat'}</h2>
    <button class="ai-icon-button" class:active={showHistory} type="button" aria-label="Chat history" aria-pressed={showHistory} title="Chats" onclick={() => { showHistory = !showHistory; if (showHistory) void loadChatList(); }}>
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path d="M3.2 10a6.8 6.8 0 1 0 2-4.8L3.2 7.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        <path d="M3 3.8v3.6h3.6M10 6.6V10l2.4 1.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
    <button class="ai-icon-button" type="button" aria-label="New chat" title="New chat" disabled={!entries.length && !showHistory} onclick={newChat}>
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path d="M9 3.5H5.5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        <path d="M14.6 2.9a1.6 1.6 0 0 1 2.3 2.3l-6.3 6.3-3 .7.7-3 6.3-6.3Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
      </svg>
    </button>
    <button class="ai-close" type="button" aria-label="Close AI Chat" onclick={onClose}><span></span><span></span></button>
  </header>

  <div class="ai-scroll" bind:this={scroller} onscroll={handleScroll}>
    <div bind:this={scrollContent}>
    {#snippet chatRow(/** @type {{ id: string; title: string; document: string | null; updatedAt: string }} */ saved)}
      <div class="ai-chat-row" class:current={chat?.id === saved.id}>
        <button type="button" class="ai-chat-open" disabled={busy} onclick={() => resumeChat(saved.id)}>
          <span class="ai-chat-title">{saved.title}</span>
          <span class="ai-chat-meta">{saved.document ?? 'No document'} · {relativeTime(saved.updatedAt)}</span>
        </button>
        <button type="button" class="ai-chat-delete" aria-label={`Delete chat ${saved.title}`} title="Delete" onclick={() => deleteSavedChat(saved.id)}><span></span><span></span></button>
      </div>
    {/snippet}
    {#if showHistory}
      <div class="ai-history" in:fade={{ duration: 150 }}>
        {#if savedChats.length}
          {#each savedChats as saved (saved.id)}{@render chatRow(saved)}{/each}
        {:else}
          <p class="ai-history-empty">No saved chats yet.</p>
        {/if}
      </div>
    {:else if !entries.length}
      <div class="ai-empty" in:fade={{ duration: 180 }}>
        <span class="ai-empty-mark" aria-hidden="true"><img src="/brain.svg" alt="" /></span>
        <h3>Docuflex AI</h3>
        <p>Ask about your document or tell me what to change. I read, edit, comment and organize pages right here, and every change can be undone.</p>
        <div class="ai-suggestions">
          {#each suggestions as suggestion (suggestion.label)}
            <button type="button" class="ai-suggestion" disabled={!status?.available} onclick={() => send(suggestion.prompt)}>
              <span>{suggestion.label}</span>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
            </button>
          {/each}
        </div>
        {#if savedChats.length}
          <div class="ai-recent">
            <div class="ai-recent-heading">
              <span>Recent chats</span>
              {#if savedChats.length > 4}<button type="button" onclick={() => (showHistory = true)}>Show all</button>{/if}
            </div>
            {#each savedChats.slice(0, 4) as saved (saved.id)}{@render chatRow(saved)}{/each}
          </div>
        {/if}
      </div>
    {:else}
      <div class="ai-thread">
        {#each entries as entry (entry.id)}
          {#if entry.role === 'user'}
            <div class="ai-user" in:fly={{ y: 8, duration: 220, easing: cubicOut }}>
              {#if entry.quote}
                <p class="ai-quote">{#if entry.quote.page}<span>Page {entry.quote.page}</span>{/if}“{entry.quote.text}”</p>
              {/if}
              {#if entry.images.length}
                <div class="ai-user-images">
                  {#each entry.images as image, index (index)}<img src={image} alt="Attached" />{/each}
                </div>
              {/if}
              {#if entry.text}<p class="ai-user-text">{entry.text}</p>{/if}
            </div>
          {:else if entry.role === 'assistant'}
            <div class="ai-turn">
              {#if entry.reasoning}
                <button
                  type="button"
                  class="ai-thinking"
                  class:live={entry.streaming && !entry.text && !entry.tools.length}
                  aria-expanded={entry.showReasoning}
                  onclick={() => { entry.showReasoning = !entry.showReasoning; refresh(); }}
                >
                  <span>
                    {#if entry.streaming && !entry.thinkingMs}Thinking{#if entry.thinkingStartedAt} · {duration(now - entry.thinkingStartedAt)}{/if}{:else}Thought for {duration(entry.thinkingMs)}{/if}
                  </span>
                  <svg class:open={entry.showReasoning} width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
                </button>
                {#if entry.showReasoning}
                  <p class="ai-reasoning" transition:slide={{ duration: 200, easing: cubicOut }}>{entry.reasoning.trim()}</p>
                {/if}
              {:else if entry.streaming && !entry.text && !entry.tools.length}
                <div class="ai-thinking live static"><span>Working</span></div>
              {/if}

              {#if entry.text}
                <div class="ai-markdown" class:streaming={entry.streaming && !entry.tools.length}>{@html renderMarkdown(entry.text)}</div>
              {/if}

              {#if entry.tools.length}
                <div class="ai-tools">
                  {#each entry.tools as tool (tool.id)}
                    {@const info = toolInfo.get(tool.name)}
                    <div class="ai-tool" class:expanded={tool.expanded} data-status={tool.status} in:fly={{ y: 6, duration: 200, easing: cubicOut }}>
                      <button type="button" class="ai-tool-row" aria-expanded={tool.expanded} onclick={() => { tool.expanded = !tool.expanded; refresh(); }}>
                        <img class="ai-tool-icon" src={TOOL_ICONS[tool.name] ?? '/toolbar/small/select.svg'} alt="" />
                        <span class="ai-tool-title">{info?.title ?? tool.name}</span>
                        <span class="ai-tool-detail">{summarizeArgs(tool.name, tool.args)}</span>
                        <span class="ai-tool-state" title={statusLabel(tool.status)} aria-label={statusLabel(tool.status)}>
                          {#if tool.status === 'streaming' || tool.status === 'running'}
                            <span class="ai-spinner"></span>
                          {:else if tool.status === 'done'}
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="m3.5 8.5 3 3 6-7" stroke="#2fb344" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" /></svg>
                          {:else if tool.status === 'error'}
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="#c83e3e" stroke-width="1.5" /><path d="M8 4.8v3.7M8 10.9v.1" stroke="#c83e3e" stroke-width="1.6" stroke-linecap="round" /></svg>
                          {:else if tool.status === 'approval'}
                            <span class="ai-approval-dot"></span>
                          {:else}
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="#9a9a9a" stroke-width="1.5" stroke-linecap="round" /></svg>
                          {/if}
                        </span>
                      </button>

                      {#if tool.status === 'approval'}
                        <div class="ai-approval" transition:slide={{ duration: 200, easing: cubicOut }}>
                          <p>{approvalText(tool)}</p>
                          <div class="ai-approval-actions">
                            <button type="button" class="ai-action secondary" onclick={() => answerApproval(tool.id, false)}>Deny</button>
                            <button type="button" class="ai-action primary" onclick={() => answerApproval(tool.id, true)}>Allow</button>
                          </div>
                        </div>
                      {/if}

                      {#if tool.helpers?.length}
                        <div class="ai-helpers">
                          {#each tool.helpers as helper (helper.id)}
                            <div class="ai-helper" data-status={helper.status}>
                              <span class="ai-helper-state" aria-label={helper.status}>
                                {#if helper.status === 'running'}
                                  <span class="ai-spinner"></span>
                                {:else if helper.status === 'done'}
                                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="m3.5 8.5 3 3 6-7" stroke="#2fb344" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
                                {:else}
                                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke={helper.status === 'error' ? '#c83e3e' : '#9a9a9a'} stroke-width="1.6" stroke-linecap="round" /></svg>
                                {/if}
                              </span>
                              <span class="ai-helper-task" title={helper.task}>{helper.task}</span>
                              <span class="ai-helper-detail" title={helper.summary || undefined}>
                                Page {helper.page}{helper.region ? ' · area' : ''} ·
                                {#if helper.status === 'running'}{helper.current || 'Starting'} · {helper.steps} {helper.steps === 1 ? 'step' : 'steps'}{:else}{helper.summary}{/if}
                              </span>
                            </div>
                          {/each}
                        </div>
                      {/if}

                      {#if tool.image}
                        <button type="button" class="ai-tool-image" class:large={tool.expanded} aria-label="Toggle page image size" onclick={() => { tool.expanded = !tool.expanded; refresh(); }}>
                          <img src={tool.image} alt={`Rendered page ${tool.args.page ?? ''}`} />
                        </button>
                      {/if}

                      {#if tool.expanded}
                        <div class="ai-tool-details" transition:slide={{ duration: 200, easing: cubicOut }}>
                          <span>Input</span>
                          <pre>{displayArgs(tool.args)}</pre>
                          {#if tool.result}
                            <span>{tool.status === 'error' ? 'Error' : 'Result'}</span>
                            <pre class:error={tool.status === 'error'}>{prettyResult(tool.result)}</pre>
                          {/if}
                        </div>
                      {/if}
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          {:else if entry.role === 'note'}
            <p class="ai-note" in:fade={{ duration: 160 }}><span>{entry.text}</span></p>
          {:else}
            <div class="ai-error" role="alert" in:fly={{ y: 6, duration: 200, easing: cubicOut }}>
              <p>{entry.text}</p>
              {#if !busy && entry === entries[entries.length - 1]}
                <button type="button" class="ai-action secondary" onclick={retry}>Retry</button>
              {/if}
            </div>
          {/if}
        {/each}
      </div>
    {/if}
    </div>
  </div>

  <footer class="ai-composer">
    {#if selectionQuote || attachments.length}
      <div class="ai-chips" transition:slide={{ duration: 180, easing: cubicOut }}>
        {#if selectionQuote}
          <div class="ai-chip quote">
            <span>{#if selectionQuote.page}<em>Page {selectionQuote.page}</em>{/if}“{selectionQuote.text}”</span>
            <button type="button" aria-label="Remove selected text" onclick={() => { usedSelection = selectionQuote?.text ?? ''; selectionQuote = null; }}><span></span><span></span></button>
          </div>
        {/if}
        {#each attachments as image, index (image)}
          <div class="ai-chip image">
            <img src={image} alt="Attachment" />
            <button type="button" aria-label="Remove image" onclick={() => (attachments = attachments.filter((_, item) => item !== index))}><span></span><span></span></button>
          </div>
        {/each}
      </div>
    {/if}

    <div class="ai-input" class:focus-ring={dragging}>
      <textarea
        bind:this={input}
        bind:value={draft}
        rows="1"
        placeholder={busy ? 'Working… Press Esc to stop' : hasDocument ? 'Ask or tell Docuflex AI what to do…' : 'Ask Docuflex AI…'}
        aria-label="Message"
        disabled={!status?.available}
        oninput={autosize}
        onkeydown={handleKeydown}
        onpaste={handlePaste}
      ></textarea>
      <div class="ai-input-bar">
        <button class="ai-icon-button attach" type="button" aria-label="Attach image" title="Attach image" disabled={!status?.available || busy} onclick={() => fileInput?.click()}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m16.2 9.4-6.3 6.3a4 4 0 0 1-5.7-5.7l6.6-6.6a2.7 2.7 0 0 1 3.8 3.8l-6.6 6.6a1.3 1.3 0 0 1-1.9-1.9l6-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </button>
        <span class="ai-model" title={status?.fallbackModel ? `Falls back to ${modelName(status.fallbackModel)}` : undefined}>{modelLabel}</span>
        {#if busy}
          <button class="ai-send stop" type="button" aria-label="Stop" title="Stop (Esc)" onclick={stop} in:fade={{ duration: 120 }}>
            <span></span>
          </button>
        {:else}
          <button class="ai-send" type="button" aria-label="Send" title="Send (Enter)" disabled={(!draft.trim() && !attachments.length) || !status?.available} onclick={() => send()} in:fade={{ duration: 120 }}>
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M9 14.5v-11M4.5 8 9 3.5 13.5 8" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
          </button>
        {/if}
      </div>
    </div>

    <p class="ai-meta">
      {#if activeDocument}
        <span class="ai-context" title={activeDocument.name}>
          <img src="/pdficon.svg" alt="" />
          <span>{activeDocument.name}</span>
          {#if activeDocument.currentPage}<em>· Page {activeDocument.currentPage}{#if activeDocument.selectedPages?.length > 1} · {activeDocument.selectedPages.length} selected{/if}</em>{/if}
        </span>
      {:else}
        <span class="ai-context"><span>No document open</span></span>
      {/if}
      {#if usage.tokens}<span class="ai-usage" title={`${usage.tokens.toLocaleString()} tokens this chat`}>${usage.cost.toFixed(usage.cost < 0.01 ? 4 : 3)}</span>{/if}
    </p>
  </footer>
  <input bind:this={fileInput} class="ai-file-input" type="file" accept="image/*" multiple onchange={(event) => { void addImages([...(event.currentTarget.files ?? [])]); event.currentTarget.value = ''; }} />
</aside>

<style>
  /* Floating window like Sign, Comments and MCP: same card, header and shadow. */
  .ai-panel {
    position: fixed;
    z-index: 70;
    top: 70px;
    right: 14px;
    bottom: 14px;
    display: grid;
    grid-template-rows: 50px minmax(0, 1fr) auto;
    /* One column at the panel width: long unbroken text must never widen it. */
    grid-template-columns: minmax(0, 1fr);
    box-sizing: border-box;
    width: min(400px, calc(100% - 28px));
    min-height: 0;
    overflow: hidden;
    border: 1.5px solid #c5c5c5;
    border-radius: 13px;
    background: #fafafa;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.12);
    color: #000;
    font-family: "Inter Variable", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 16px;
    opacity: 0;
    pointer-events: none;
    visibility: hidden;
    transform: translateX(18px);
    transition: opacity 200ms ease, transform 240ms cubic-bezier(0.22, 1, 0.36, 1), visibility 0s linear 240ms, border-color 160ms ease, box-shadow 200ms ease;
    -webkit-font-smoothing: antialiased;
  }

  .ai-panel.open {
    opacity: 1;
    pointer-events: auto;
    visibility: visible;
    transform: none;
    transition: opacity 200ms ease, transform 240ms cubic-bezier(0.22, 1, 0.36, 1), visibility 0s, border-color 160ms ease, box-shadow 200ms ease;
  }

  .ai-panel.dragging {
    border-color: #0878f9;
    box-shadow: 0 0 0 3px rgba(8, 120, 249, 0.14), 0 12px 32px rgba(0, 0, 0, 0.12);
  }

  /* Header: same strip as the signature, comment and MCP windows. */
  .ai-header {
    display: grid;
    grid-template-columns: 26px minmax(0, 1fr) 30px 30px 28px;
    align-items: center;
    gap: 2px;
    box-sizing: border-box;
    height: 50px;
    padding: 0 12px;
    border-bottom: 1px solid #cacaca;
    background: #eeeeee;
  }

  .ai-header > img {
    width: 23px;
    height: 24px;
  }

  .ai-header h2 {
    margin: 0 0 0 7px;
    overflow: hidden;
    font-size: 18px;
    font-weight: 400;
    line-height: 1.22;
    letter-spacing: -0.25px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ai-icon-button {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: #929292;
    cursor: pointer;
    transition: color 160ms ease, background-color 160ms ease, transform 160ms ease;
  }

  .ai-icon-button:hover:not(:disabled) {
    background: rgba(0, 0, 0, 0.05);
    color: #000;
  }

  .ai-icon-button:active:not(:disabled) {
    transform: scale(0.94);
  }

  .ai-icon-button:disabled {
    cursor: default;
    opacity: 0.4;
  }

  .ai-close {
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

  .ai-close:active {
    transform: scale(0.94);
  }

  .ai-close span,
  .ai-chip button span {
    position: absolute;
    top: 13px;
    left: 6px;
    width: 16px;
    height: 1.5px;
    border-radius: 999px;
    background: #929292;
    transform: rotate(45deg);
    transition: background-color 160ms ease;
  }

  .ai-close span + span,
  .ai-chip button span + span {
    transform: rotate(-45deg);
  }

  .ai-close:hover span,
  .ai-chip button:hover span {
    background: #000;
  }

  .ai-icon-button.active {
    background: #111;
    color: #fff;
  }

  .ai-icon-button.active:hover:not(:disabled) {
    background: #000;
    color: #fff;
  }

  /* Saved chats */
  .ai-history {
    display: grid;
    gap: 8px;
    padding: 16px 18px;
  }

  .ai-history-empty {
    margin: 24px 0;
    color: #9a9a9a;
    font-size: 16px;
    text-align: center;
  }

  .ai-recent {
    display: grid;
    gap: 8px;
    width: 100%;
    margin-top: 14px;
    text-align: left;
  }

  .ai-recent-heading {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding: 0 2px;
    color: #7a7a7a;
    font-size: 14px;
  }

  .ai-recent-heading button {
    padding: 0;
    border: 0;
    background: none;
    color: #0878f9;
    font: inherit;
    cursor: pointer;
  }

  .ai-chat-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 32px;
    align-items: center;
    overflow: hidden;
    border: 1px solid #d7d7d7;
    border-radius: 8px;
    background: #f3f3f3;
    transition: background-color 180ms ease, border-color 180ms ease;
  }

  .ai-chat-row:hover {
    border-color: #c8c8c8;
    background: #eeeeee;
  }

  .ai-chat-row.current {
    border-color: #0878f9;
  }

  .ai-chat-open {
    display: grid;
    gap: 2px;
    min-width: 0;
    padding: 8px 4px 9px 12px;
    border: 0;
    background: transparent;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .ai-chat-open:disabled {
    cursor: default;
    opacity: 0.6;
  }

  .ai-chat-title,
  .ai-chat-meta {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ai-chat-title {
    color: #111;
    font-size: 15px;
    letter-spacing: -0.2px;
  }

  .ai-chat-meta {
    color: #9a9a9a;
    font-size: 13px;
  }

  .ai-chat-delete {
    position: relative;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: pointer;
    opacity: 0;
    transform: scale(0.8);
    transition: opacity 150ms ease;
  }

  .ai-chat-row:hover .ai-chat-delete,
  .ai-chat-delete:focus-visible {
    opacity: 1;
  }

  .ai-chat-delete span {
    position: absolute;
    top: 13px;
    left: 6px;
    width: 16px;
    height: 1.5px;
    border-radius: 999px;
    background: #929292;
    transform: rotate(45deg);
  }

  .ai-chat-delete span + span {
    transform: rotate(-45deg);
  }

  .ai-chat-delete:hover span {
    background: #c83e3e;
  }

  /* Conversation */
  .ai-scroll {
    min-width: 0;
    min-height: 0;
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    scrollbar-color: #d0d0d0 transparent;
  }

  .ai-empty {
    display: grid;
    justify-items: center;
    gap: 10px;
    padding: 46px 22px 24px;
    text-align: center;
  }

  .ai-empty-mark {
    display: grid;
    place-items: center;
    width: 58px;
    height: 58px;
    margin-bottom: 4px;
    border: 1px solid #d7d7d7;
    border-radius: 16px;
    background: #f3f3f3;
    box-shadow: inset 0 -2px 0 rgba(0, 0, 0, 0.03);
  }

  .ai-empty-mark img {
    width: 30px;
    height: 31px;
  }

  .ai-empty h3 {
    margin: 0;
    font-size: 22px;
    font-weight: 400;
    letter-spacing: -0.4px;
  }

  .ai-empty p {
    max-width: 320px;
    margin: 0 0 10px;
    color: #7a7a7a;
    font-size: 16px;
    line-height: 1.42;
    letter-spacing: -0.2px;
  }

  .ai-suggestions {
    display: grid;
    gap: 8px;
    width: 100%;
  }

  .ai-suggestion {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    min-height: 42px;
    padding: 0 12px;
    border: 1px solid #d7d7d7;
    border-radius: 8px;
    background: #f3f3f3;
    color: #3f3f3f;
    font: inherit;
    font-size: 16px;
    letter-spacing: -0.2px;
    text-align: left;
    cursor: pointer;
    transition: background-color 180ms ease, border-color 180ms ease, color 180ms ease, transform 160ms ease;
  }

  .ai-suggestion svg {
    flex: none;
    color: #9a9a9a;
    transition: color 180ms ease, transform 180ms ease;
  }

  .ai-suggestion:hover {
    border-color: #c8c8c8;
    background: #eeeeee;
    color: #000;
  }

  .ai-suggestion:hover svg {
    color: #0878f9;
    transform: translateX(2px);
  }

  .ai-suggestion:active {
    transform: scale(0.99);
  }

  .ai-thread {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 16px;
    padding: 18px 18px 22px;
  }

  .ai-user {
    display: grid;
    gap: 8px;
    justify-self: end;
    max-width: 88%;
    padding: 10px 13px 11px;
    border: 1px solid #d7d7d7;
    border-radius: 12px 12px 4px 12px;
    background: #f0f0f0;
  }

  .ai-user-text {
    margin: 0;
    color: #111;
    font-size: 16px;
    line-height: 1.42;
    letter-spacing: -0.2px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .ai-quote {
    display: -webkit-box;
    margin: 0;
    padding: 6px 10px;
    overflow: hidden;
    border-left: 3px solid #ffd60a;
    border-radius: 6px;
    background: #fafafa;
    color: #4a4a4a;
    font-size: 14px;
    line-height: 1.38;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
  }

  .ai-quote span {
    margin-right: 6px;
    color: #9a9a9a;
  }

  .ai-user-images {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .ai-user-images img {
    width: 72px;
    height: 72px;
    border: 1px solid #d7d7d7;
    border-radius: 6px;
    object-fit: cover;
  }

  .ai-turn {
    display: grid;
    gap: 10px;
    min-width: 0;
  }

  .ai-thinking {
    display: inline-flex;
    align-items: center;
    justify-self: start;
    gap: 4px;
    padding: 0;
    border: 0;
    background: transparent;
    color: #8a8a8a;
    font: inherit;
    font-size: 15px;
    letter-spacing: -0.2px;
    cursor: pointer;
  }

  .ai-thinking.static {
    cursor: default;
  }

  .ai-thinking svg {
    transition: transform 200ms ease;
  }

  .ai-thinking svg.open {
    transform: rotate(90deg);
  }

  .ai-thinking:hover:not(.static) {
    color: #000;
  }

  /* Shimmer on the label while the model is thinking. */
  .ai-thinking.live span {
    background: linear-gradient(90deg, #9a9a9a 0%, #9a9a9a 35%, #1a1a1a 50%, #9a9a9a 65%, #9a9a9a 100%);
    background-size: 220% 100%;
    background-clip: text;
    -webkit-background-clip: text;
    color: transparent;
    animation: ai-shimmer 1.6s linear infinite;
  }

  @keyframes ai-shimmer {
    from { background-position: 110% 0; }
    to { background-position: -110% 0; }
  }

  .ai-reasoning {
    margin: 0;
    padding: 2px 0 2px 12px;
    border-left: 2px solid #dedede;
    color: #8a8a8a;
    font-size: 14px;
    line-height: 1.45;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .ai-markdown {
    min-width: 0;
    color: #1a1a1a;
    font-size: 16px;
    line-height: 1.5;
    letter-spacing: -0.2px;
    overflow-wrap: anywhere;
  }

  .ai-markdown :global(p),
  .ai-markdown :global(ul),
  .ai-markdown :global(ol),
  .ai-markdown :global(pre),
  .ai-markdown :global(blockquote),
  .ai-markdown :global(h3),
  .ai-markdown :global(h4),
  .ai-markdown :global(h5),
  .ai-markdown :global(h6) {
    margin: 0 0 9px;
  }

  .ai-markdown > :global(:last-child) {
    margin-bottom: 0;
  }

  .ai-markdown :global(h3),
  .ai-markdown :global(h4),
  .ai-markdown :global(h5),
  .ai-markdown :global(h6) {
    font-size: 17px;
    font-weight: 600;
    letter-spacing: -0.3px;
  }

  .ai-markdown :global(strong) {
    font-weight: 600;
  }

  .ai-markdown :global(ul),
  .ai-markdown :global(ol) {
    padding-left: 22px;
  }

  .ai-markdown :global(li + li) {
    margin-top: 3px;
  }

  .ai-markdown :global(code) {
    padding: 1px 5px;
    border: 1px solid #e0e0e0;
    border-radius: 5px;
    background: #f0f0f0;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 13.5px;
  }

  .ai-markdown :global(pre) {
    padding: 10px 12px;
    overflow-x: auto;
    border: 1px solid #d7d7d7;
    border-radius: 8px;
    background: #f3f3f3;
  }

  .ai-markdown :global(pre code) {
    padding: 0;
    border: 0;
    background: transparent;
  }

  .ai-markdown :global(blockquote) {
    padding: 2px 0 2px 12px;
    border-left: 3px solid #ffd60a;
    color: #4a4a4a;
  }

  .ai-markdown :global(a) {
    color: #0878f9;
    text-decoration: none;
  }

  .ai-markdown :global(a:hover) {
    text-decoration: underline;
  }

  .ai-markdown :global(hr) {
    margin: 12px 0;
    border: 0;
    border-top: 1px solid #dedede;
  }

  /* Caret while text streams in. */
  .ai-markdown.streaming > :global(:last-child)::after {
    display: inline-block;
    width: 7px;
    height: 15px;
    margin-left: 3px;
    border-radius: 2px;
    background: #0878f9;
    vertical-align: -2px;
    content: '';
    animation: ai-caret 1s steps(2, start) infinite;
  }

  @keyframes ai-caret {
    to { visibility: hidden; }
  }

  /* Tool calls: grouped like the comment thread list. */
  .ai-tools {
    display: grid;
    overflow: hidden;
    border: 1px solid #d7d7d7;
    border-radius: 8px;
    background: #f3f3f3;
  }

  .ai-tool + .ai-tool {
    border-top: 1px solid #dedede;
  }

  .ai-tool-row {
    display: grid;
    grid-template-columns: 20px auto minmax(0, 1fr) 18px;
    align-items: center;
    gap: 9px;
    width: 100%;
    min-height: 40px;
    padding: 0 11px;
    border: 0;
    background: transparent;
    color: #111;
    font: inherit;
    font-size: 15px;
    letter-spacing: -0.2px;
    text-align: left;
    cursor: pointer;
    transition: background-color 160ms ease;
  }

  .ai-tool-row:hover {
    background: #ececec;
  }

  .ai-tool-icon {
    width: 19px;
    height: 19px;
    object-fit: contain;
  }

  .ai-tool-title {
    white-space: nowrap;
  }

  .ai-tool-detail {
    overflow: hidden;
    color: #7a7a7a;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ai-tool[data-status='denied'] .ai-tool-title,
  .ai-tool[data-status='cancelled'] .ai-tool-title {
    color: #9a9a9a;
    text-decoration: line-through;
    text-decoration-color: #c0c0c0;
  }

  .ai-tool-state {
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
  }

  .ai-spinner {
    width: 13px;
    height: 13px;
    border: 1.6px solid #d0d0d0;
    border-top-color: #0878f9;
    border-radius: 50%;
    animation: ai-spin 700ms linear infinite;
  }

  @keyframes ai-spin {
    to { transform: rotate(360deg); }
  }

  .ai-approval-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #f0a020;
    box-shadow: 0 0 0 3px rgba(240, 160, 32, 0.2);
  }

  /* Helper agents under a delegate call */
  .ai-helpers {
    display: grid;
    gap: 6px;
    padding: 0 11px 11px 40px;
  }

  .ai-helper {
    display: grid;
    grid-template-columns: 16px minmax(0, 1fr);
    column-gap: 8px;
    row-gap: 1px;
    align-items: center;
    padding: 7px 10px 8px;
    border: 1px solid #e0e0e0;
    border-radius: 7px;
    background: #fafafa;
  }

  .ai-helper-state {
    display: grid;
    grid-row: span 2;
    place-items: center;
    align-self: start;
    height: 18px;
  }

  .ai-helper-task {
    overflow: hidden;
    color: #111;
    font-size: 14px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ai-helper-detail {
    display: -webkit-box;
    overflow: hidden;
    color: #8a8a8a;
    font-size: 12.5px;
    line-height: 1.35;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  .ai-helper[data-status='error'] .ai-helper-detail {
    color: #c83e3e;
  }

  .ai-approval {
    display: grid;
    gap: 10px;
    padding: 2px 11px 12px 40px;
  }

  .ai-approval p {
    margin: 0;
    color: #3f3f3f;
    font-size: 15px;
    line-height: 1.38;
    overflow-wrap: anywhere;
  }

  .ai-approval-actions {
    display: grid;
    grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.4fr);
    gap: 8px;
  }

  .ai-action {
    display: flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    height: 36px;
    padding: 0 12px;
    border-radius: 8px;
    font: inherit;
    font-size: 16px;
    letter-spacing: -0.3px;
    cursor: pointer;
    transition: background-color 220ms ease, border-color 180ms ease, box-shadow 220ms ease, transform 160ms ease;
  }

  .ai-action:active {
    transform: scale(0.985);
  }

  .ai-action.primary {
    border: 0;
    background: #0878f9;
    color: #fff;
    box-shadow: 0 5px 16px rgba(8, 120, 249, 0.18);
  }

  .ai-action.primary:hover {
    background: #006ff0;
    box-shadow: 0 6px 18px rgba(8, 120, 249, 0.27);
  }

  .ai-action.secondary {
    border: 1px solid #d7d7d7;
    background: #fafafa;
    color: #7a7a7a;
  }

  .ai-action.secondary:hover {
    border-color: #c8c8c8;
    background: #eeeeee;
    color: #3f3f3f;
  }

  .ai-tool-image {
    display: block;
    width: calc(100% - 51px);
    margin: 0 11px 11px 40px;
    padding: 0;
    overflow: hidden;
    border: 1px solid #d7d7d7;
    border-radius: 6px;
    background: #fff;
    cursor: zoom-in;
  }

  .ai-tool-image img {
    display: block;
    width: 100%;
    max-height: 170px;
    object-fit: cover;
    object-position: top;
    transition: max-height 300ms cubic-bezier(0.22, 1, 0.36, 1);
  }

  .ai-tool-image.large {
    cursor: zoom-out;
  }

  .ai-tool-image.large img {
    max-height: 900px;
    object-fit: contain;
  }

  .ai-tool-details {
    display: grid;
    gap: 5px;
    padding: 0 11px 12px 40px;
  }

  .ai-tool-details span {
    color: #9a9a9a;
    font-size: 13px;
  }

  .ai-tool-details pre {
    max-height: 220px;
    margin: 0 0 4px;
    padding: 8px 10px;
    overflow: auto;
    border: 1px solid #e0e0e0;
    border-radius: 6px;
    background: #fafafa;
    color: #3f3f3f;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    line-height: 1.45;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .ai-tool-details pre.error {
    border-color: #efcaca;
    background: #fdf3f3;
    color: #c83e3e;
  }

  .ai-note {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0;
    color: #9a9a9a;
    font-size: 13.5px;
  }

  .ai-note::before,
  .ai-note::after {
    flex: 1;
    height: 1px;
    background: #e2e2e2;
    content: '';
  }

  .ai-error {
    display: grid;
    gap: 10px;
    padding: 10px 12px;
    border: 1px solid #efcaca;
    border-radius: 8px;
    background: #fdf3f3;
  }

  .ai-error p {
    margin: 0;
    color: #c83e3e;
    font-size: 15px;
    line-height: 1.38;
    overflow-wrap: anywhere;
  }

  .ai-error .ai-action {
    justify-self: start;
    height: 32px;
    font-size: 15px;
  }

  /* Composer */
  .ai-composer {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    min-width: 0;
    gap: 9px;
    padding: 12px 14px 11px;
    border-top: 1px solid #cacaca;
    background: #fafafa;
  }

  .ai-chips {
    display: flex;
    min-width: 0;
    flex-wrap: wrap;
    gap: 6px;
  }

  .ai-chip {
    position: relative;
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    border: 1px solid #d7d7d7;
    border-radius: 8px;
    background: #f3f3f3;
  }

  .ai-chip.quote {
    flex: 1 1 100%;
    max-width: 100%;
    box-sizing: border-box;
    padding: 6px 4px 6px 10px;
    border-left: 3px solid #ffd60a;
  }

  .ai-chip.quote > span {
    overflow: hidden;
    color: #4a4a4a;
    font-size: 14px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ai-chip.quote em {
    margin-right: 6px;
    color: #9a9a9a;
    font-style: normal;
  }

  .ai-chip.image {
    padding: 3px;
  }

  .ai-chip.image img {
    width: 46px;
    height: 46px;
    border-radius: 5px;
    object-fit: cover;
  }

  .ai-chip button {
    position: relative;
    flex: none;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: pointer;
    transform: scale(0.8);
  }

  .ai-chip.image button {
    position: absolute;
    top: -9px;
    right: -9px;
    border: 1px solid #d7d7d7;
    border-radius: 50%;
    background: #fafafa;
    transform: scale(0.72);
  }

  .ai-input {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    min-width: 0;
    overflow: hidden;
    border: 1px solid #d7d7d7;
    border-radius: 10px;
    background: #f3f3f3;
    transition: border-color 160ms ease, background-color 160ms ease, box-shadow 160ms ease;
  }

  .ai-input:focus-within,
  .ai-input.focus-ring {
    border-color: #b8b8b8;
    background: #f7f7f7;
  }

  .ai-input textarea {
    box-sizing: border-box;
    overflow-wrap: anywhere;
    width: 100%;
    min-height: 46px;
    max-height: 180px;
    padding: 12px 13px 4px;
    border: 0;
    outline: none;
    background: transparent;
    color: #000;
    font: inherit;
    font-size: 17px;
    line-height: 1.38;
    letter-spacing: -0.25px;
    resize: none;
  }

  .ai-input textarea::placeholder {
    color: #8a8a8a;
  }

  .ai-input-bar {
    display: grid;
    grid-template-columns: 28px minmax(0, 1fr) 34px;
    align-items: center;
    gap: 6px;
    padding: 4px 7px 7px;
  }

  .ai-model {
    overflow: hidden;
    color: #9a9a9a;
    font-size: 13.5px;
    text-align: right;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ai-send {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    padding: 0;
    border: 0;
    border-radius: 8px;
    background: #0878f9;
    box-shadow: 0 5px 16px rgba(8, 120, 249, 0.18);
    cursor: pointer;
    transition: background-color 200ms ease, box-shadow 200ms ease, opacity 160ms ease, transform 160ms ease;
  }

  .ai-send:hover:not(:disabled) {
    background: #006ff0;
    box-shadow: 0 6px 18px rgba(8, 120, 249, 0.27);
  }

  .ai-send:active:not(:disabled) {
    transform: scale(0.94);
  }

  .ai-send:disabled {
    background: #c9c9c9;
    box-shadow: none;
    cursor: default;
  }

  .ai-send.stop {
    background: #111;
    box-shadow: 0 5px 14px rgba(0, 0, 0, 0.16);
  }

  .ai-send.stop:hover {
    background: #000;
  }

  .ai-send.stop span {
    width: 11px;
    height: 11px;
    border-radius: 2.5px;
    background: #fff;
  }

  .ai-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    min-width: 0;
    margin: 0;
    padding: 0 2px;
    color: #9a9a9a;
    font-size: 13.5px;
  }

  .ai-context {
    display: flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
  }

  .ai-context img {
    flex: none;
    width: 14px;
    height: 14px;
  }

  .ai-context span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ai-context em {
    flex: none;
    font-style: normal;
  }

  .ai-usage {
    flex: none;
    font-variant-numeric: tabular-nums;
  }

  .ai-file-input {
    display: none;
  }

  @media (prefers-reduced-motion: reduce) {
    .ai-panel,
    .ai-thinking.live span,
    .ai-spinner,
    .ai-markdown.streaming > :global(:last-child)::after {
      transition: none;
      animation: none;
    }
  }
</style>
