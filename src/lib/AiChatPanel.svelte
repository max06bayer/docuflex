<script>
  import { onDestroy, onMount, tick } from 'svelte';
  import { cubicOut } from 'svelte/easing';
  import { fade, fly, slide } from 'svelte/transition';
  import { onMathRendered, renderMarkdown } from '$lib/ai-markdown.js';
  import AiFieldBackground from '$lib/AiFieldBackground.svelte';
  import {
    deleteVisitorChat, downloadPdf, fileToBase64, listVisitorChats, pickPdf, readVisitorChat,
    runVisitorMemoryTool, saveVisitorChat, visitorKey, visitorMemories
  } from '$lib/ai-web.js';

  /**
   * AI chat docked next to the document. The model (through /api/ai/chat)
   * answers and asks for tool calls; this window runs the agent loop and the
   * calls go through /api/ai/tool, the same code path as the MCP server, so
   * every edit shows up live and can be undone.
   */

  export let open = false;
  /** @type {{ available: boolean; mode?: string; model?: string; models?: { id: string; name: string; short?: string }[]; fallbackModel?: string; tools?: { name: string; title: string; readOnly: boolean; needsApproval: boolean }[] } | null} */
  export let status = null;
  /** @type {() => any} */
  export let getContext = () => ({});
  export let hasDocument = false;
  /** @type {() => void} */
  export let onClose = () => {};
  /** Lets the top bar show that the agent is working while the panel is closed. */
  /** @type {(busy: boolean) => void} */
  export let onBusyChange = () => {};
  /** Website only: runs a tool in this window (the same handler the desktop's MCP bridge calls). */
  /** @type {(name: string, args: Record<string, any>) => Promise<any>} */
  export let runLocalTool = async () => { throw new Error('Tools are not available here.'); };
  /** Website visitors bring their own key and keep chats and notes in this browser. */
  $: web = status?.mode === 'web';

  /** Headers for /api/ai/chat; on the website the visitor's key rides along with each request. */
  function chatHeaders() {
    /** @type {Record<string, string>} */
    const headers = { 'Content-Type': 'application/json' };
    const key = web ? visitorKey() : null;
    if (key) headers['X-OpenRouter-Key'] = key;
    return headers;
  }

  /** @typedef {'streaming' | 'running' | 'approval' | 'done' | 'error' | 'denied' | 'cancelled'} ToolStatus */
  /** @typedef {{ x: number; y: number; width: number; height: number }} Region */
  /** @typedef {{ id: number; task: string; page: number; region: Region | null; status: 'running' | 'done' | 'error' | 'cancelled'; steps: number; current: string; summary: string; objects: number[] }} Helper */
  /** @typedef {{ id: string; name: string; rawArgs: string; args: Record<string, any>; status: ToolStatus; result: string; image: string | null; expanded: boolean; helpers?: Helper[] }} ToolEntry */
  /** @typedef {{ id: number; role: 'user'; text: string; quote: { text: string; page: number | null } | null; images: string[]; startedAt?: number; doneAt?: number }} UserEntry */
  /** @typedef {{ id: number; role: 'assistant'; text: string; reasoning: string; thinkingStartedAt: number | null; thinkingMs: number; showReasoning: boolean; tools: ToolEntry[]; streaming: boolean }} AssistantEntry */
  /** @typedef {{ id: number; role: 'error' | 'note'; text: string }} ErrorEntry */
  /** @typedef {UserEntry | AssistantEntry | ErrorEntry} Entry */
  /**
   * What the thread shows: each request's steps fold into one "Worked for …"
   * line, and only the final reply is shown as text.
   * @typedef {{ kind: 'entry'; id: string; entry: UserEntry | ErrorEntry } | { kind: 'work'; id: string; steps: AssistantEntry[]; request: UserEntry | null } | { kind: 'answer'; id: string; entry: AssistantEntry }} Block
   */

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

  const MODEL_STORAGE_KEY = 'docuflex-ai-model';

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
  /** Work blocks the person opened. */
  let openWork = new Set();
  /** The model chosen in the composer; remembered on this computer. */
  let selectedModel = '';
  let modelMenuOpen = false;

  $: blocks = groupEntries(entries);
  $: toolInfo = new Map((status?.tools ?? []).map((tool) => [tool.name, tool]));
  $: models = status?.models?.length ? status.models : status?.model ? [{ id: status.model, name: modelName(status.model) }] : [];
  $: if (models.length && !models.some((model) => model.id === selectedModel)) selectedModel = storedModel(models) ?? models[0].id;
  $: currentModel = models.find((model) => model.id === selectedModel);
  $: modelLabel = currentModel?.short ?? currentModel?.name ?? modelName(selectedModel);
  $: onBusyChange(busy);
  $: if (open) void onOpen();
  $: activeDocument = liveContext?.active ?? null;
  $: suggestions = hasDocument
    ? [
        { label: 'Summarize', prompt: 'Summarize this document in a few bullet points with page references.', icon: '/redesign/icon-letter-text.svg' },
        { label: 'Highlight dates and amounts', prompt: 'Highlight every date and every money amount in this document.', icon: '/toolbar/small/highlight.svg' },
        { label: 'Fill out the form', prompt: 'List the form fields in this document and help me fill them out.', icon: '/toolbar/small/input.svg' }
      ]
    : [{ label: 'What can you do?', prompt: 'What can you do in Docuflex? Keep it short.', icon: '/redesign/icon-brain.svg' }];

  /**
   * Folds each request's steps into one work block; the last step without
   * tool calls is the reply. A step still waiting for its first words stays
   * in the work block, so "Thinking" shows there.
   * @param {Entry[]} list
   * @returns {Block[]}
   */
  function groupEntries(list) {
    /** @type {Block[]} */
    const out = [];
    /** @type {UserEntry | null} */
    let request = null;
    /** @type {{ kind: 'work'; id: string; steps: AssistantEntry[]; request: UserEntry | null } | null} */
    let work = null;
    for (const [index, entry] of list.entries()) {
      if (entry.role !== 'assistant') {
        if (entry.role === 'user') request = entry;
        work = null;
        out.push({ kind: 'entry', id: `e${entry.id}`, entry });
        continue;
      }
      const lastOfRun = list[index + 1]?.role !== 'assistant';
      if (lastOfRun && !entry.tools.length && entry.text.trim()) {
        out.push({ kind: 'answer', id: `a${entry.id}`, entry });
        continue;
      }
      if (!work) {
        work = { kind: 'work', id: `w${entry.id}`, steps: [], request };
        out.push(work);
      }
      work.steps.push(entry);
    }
    return out;
  }

  /** @param {string} id */
  function toggleWork(id) {
    if (openWork.has(id)) openWork.delete(id);
    else openWork.add(id);
    openWork = openWork;
  }

  /** The step running right now, for the live line. @param {AssistantEntry[]} steps */
  function currentStep(steps) {
    for (const step of [...steps].reverse()) {
      const tool = [...step.tools].reverse().find((item) => item.status === 'running' || item.status === 'streaming');
      if (tool) return toolInfo.get(tool.name)?.title ?? tool.name;
      if (step.streaming) return step.reasoning && !step.text ? 'Thinking' : 'Working';
    }
    return 'Working';
  }

  /**
   * Marks a title that runs past its row, so only those fade at the end.
   * @param {HTMLElement} node
   */
  function fadeWhenClipped(node) {
    const update = () => node.classList.toggle('clipped', node.scrollWidth > node.clientWidth + 1);
    const observer = new ResizeObserver(update);
    observer.observe(node);
    update();
    return { destroy: () => observer.disconnect() };
  }

  /** @param {{ id: string }[]} list */
  function storedModel(list) {
    try {
      const saved = localStorage.getItem(MODEL_STORAGE_KEY);
      return list.some((model) => model.id === saved) ? saved : null;
    } catch {
      return null;
    }
  }

  /** @param {string} id */
  function chooseModel(id) {
    selectedModel = id;
    modelMenuOpen = false;
    try {
      localStorage.setItem(MODEL_STORAGE_KEY, id);
    } catch {
      // Remembering the choice is a convenience.
    }
  }

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
      headers: chatHeaders(),
      body: JSON.stringify({ messages: trimImages(history), context: liveContext, model: selectedModel, memories: web ? visitorMemories(liveContext) : undefined }),
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
    if (web) return callToolHere(name, args);
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

  /**
   * Website: runs a tool in this window. Files come from and go to the visitor's
   * own computer: open/insert ask them to pick a PDF (inside the approval click),
   * save/extract download the result.
   * @param {string} name @param {Record<string, any>} args
   * @returns {Promise<{ text: string; image: string | null; isError: boolean }>}
   */
  async function callToolHere(name, args) {
    /** @param {unknown} value */
    const asText = (value) => (typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    const fileName = (/** @type {unknown} */ path, /** @type {string} */ fallback) => {
      const base = String(path ?? '').split(/[\\/]/).pop()?.trim() || fallback;
      return base.toLowerCase().endsWith('.pdf') ? base : `${base}.pdf`;
    };
    try {
      if (name === 'remember' || name === 'forget') {
        return { text: asText(runVisitorMemoryTool(name, args, liveContext)), image: null, isError: false };
      }
      if (name === 'open_document' || name === 'insert_pdf') {
        const file = await pickPdf();
        if (!file) return { text: 'The person did not pick a file.', image: null, isError: true };
        const base64 = await fileToBase64(file);
        const result = name === 'open_document'
          ? await runLocalTool('open_document', { name: file.name, base64, password: args.password })
          : await runLocalTool('insert_pdf', { base64, after: args.after });
        return { text: asText(result), image: null, isError: false };
      }
      if (name === 'save_document' || name === 'extract_pages') {
        const { path, ...rest } = args;
        const result = await runLocalTool(name, rest);
        const downloadName = fileName(path, name === 'save_document' ? (liveContext?.active?.name ?? 'document.pdf') : 'pages.pdf');
        downloadPdf(String(result.base64 ?? ''), downloadName);
        const { base64: _base64, ...details } = result ?? {};
        return { text: asText({ ...details, downloaded: downloadName }), image: null, isError: false };
      }
      if (name === 'add_image' && args.path) {
        return { text: 'On the website, images come from the chat: ask the person to attach the image, then pass it as dataUrl.', image: null, isError: true };
      }
      const result = await runLocalTool(name, args);
      if (name === 'render_page') {
        return {
          text: `Page ${result.page}: ${result.widthPt} × ${result.heightPt} pt, rendered at ${result.width} × ${result.height} px${result.note ? `. ${result.note}` : ''}.`,
          image: `data:image/png;base64,${result.png}`,
          isError: false
        };
      }
      return { text: asText(result) || 'Done.', image: null, isError: false };
    } catch (error) {
      return { text: error instanceof Error ? error.message : String(error), image: null, isError: true };
    }
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
          headers: chatHeaders(),
          body: JSON.stringify({ messages: trimImages(messages), context: liveContext, model: selectedModel, subagent: { page: helper.page, region: helper.region } }),
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
      const request = [...entries].reverse().find((item) => item.role === 'user');
      if (request?.role === 'user') request.doneAt = Date.now();
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
    entries = [...entries, { id: nextId++, role: 'user', text: message, quote, images, startedAt: Date.now() }];
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
    if (web) {
      savedChats = listVisitorChats();
      return;
    }
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
      if (entry.role === 'assistant') return { ...entry, streaming: false, showReasoning: false, tools: entry.tools.map((tool) => ({ ...tool, image: null, expanded: false })) };
      return entry;
    });
    const storedHistory = history.map((message) => Array.isArray(message.content)
      ? { ...message, content: message.content.map((/** @type {any} */ part) => (part.type === 'image_url' ? { type: 'text', text: '[image not kept]' } : part)) }
      : message);
    const stored = {
      id: chat.id,
      title: chat.title,
      createdAt: chat.createdAt,
      document: liveContext?.active?.name ?? null,
      entries: storedEntries,
      history: storedHistory,
      uncompactedFrom
    };
    if (web) {
      saveVisitorChat(stored);
      void loadChatList();
      return;
    }
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
      let stored;
      if (web) stored = readVisitorChat(id);
      else {
        const response = await fetch(`/api/ai/chats?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
        if (!response.ok) throw new Error();
        stored = await response.json();
      }
      entries = (stored.entries ?? []).map((/** @type {Entry} */ entry) => (entry.role === 'assistant' ? { ...entry, showReasoning: false } : entry));
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
    if (web) deleteVisitorChat(id);
    else await fetch(`/api/ai/chats?id=${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => null);
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

  /** Bumped when a formula finishes rendering, so answers redraw with it. */
  let mathTick = 0;
  const stopMathUpdates = onMathRendered(() => (mathTick += 1));

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
    stopMathUpdates();
    if (typeof document !== 'undefined') document.removeEventListener('selectionchange', handleSelectionChange);
    clearInterval(clock);
    contentObserver?.disconnect();
    controller?.abort();
  });
</script>

<svelte:window onclick={() => (modelMenuOpen = false)} />

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
  <!-- Only on the start screen and chat list; a conversation sits on the plain panel. -->
  <AiFieldBackground active={open && (!entries.length || showHistory)} strength={entries.length && !showHistory ? 0 : 1} />
  <header class="ai-header">
    <img src="/redesign/icon-brain.svg" alt="" />
    <h2>{showHistory ? 'Chats' : 'AI Chat'}</h2>
    <button class="ai-header-button" class:active={showHistory} type="button" aria-label="Chats" aria-pressed={showHistory} title="Chats" onclick={() => { showHistory = !showHistory; if (showHistory) void loadChatList(); }}>
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5M12 7v5l4 2" /></svg>
    </button>
    <button class="ai-header-button" type="button" aria-label="New chat" title="New chat" disabled={!entries.length && !showHistory} onclick={newChat}>
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.4 2.6a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4Z" /></svg>
    </button>
    <button class="ai-close" type="button" aria-label="Close AI Chat" onclick={onClose}></button>
  </header>

  <div class="ai-scroll" bind:this={scroller} onscroll={handleScroll}>
    <div class="ai-scroll-content" bind:this={scrollContent}>
    {#snippet chatRow(/** @type {{ id: string; title: string; document: string | null; updatedAt: string }} */ saved)}
      <div class="ai-chat-row" class:current={chat?.id === saved.id}>
        <button type="button" class="ai-chat-open" disabled={busy} title={saved.document ?? undefined} onclick={() => resumeChat(saved.id)}>
          <span class="ai-chat-title" use:fadeWhenClipped>{saved.title}</span>
        </button>
        <button type="button" class="ai-chat-delete" aria-label={`Delete chat ${saved.title}`} title="Delete" onclick={() => deleteSavedChat(saved.id)}></button>
      </div>
    {/snippet}
    {#if showHistory}
      <div class="ai-list" in:fade={{ duration: 150 }}>
        {#if savedChats.length}
          {#each savedChats as saved (saved.id)}{@render chatRow(saved)}{/each}
        {:else}
          <p class="ai-list-empty">No chats yet</p>
        {/if}
      </div>
    {:else if !entries.length}
      <div class="ai-empty" in:fade={{ duration: 180 }}>
        <div class="ai-list">
          {#each suggestions as suggestion (suggestion.label)}
            <button type="button" class="ai-suggestion" disabled={!status?.available} onclick={() => send(suggestion.prompt)}>
              <img src={suggestion.icon} alt="" />
              <span>{suggestion.label}</span>
            </button>
          {/each}
        </div>
        {#if savedChats.length}
          <hr class="ai-divider" />
          <div class="ai-list">
            {#each savedChats.slice(0, 5) as saved (saved.id)}{@render chatRow(saved)}{/each}
          </div>
        {/if}
      </div>
    {:else}
      <!-- One plain row per step, like Claude Code: what ran, and a chevron for its details. -->
      {#snippet toolStep(/** @type {ToolEntry} */ tool)}
        {@const info = toolInfo.get(tool.name)}
        {@const detail = summarizeArgs(tool.name, tool.args)}
        <div class="ai-step" class:expanded={tool.expanded} data-status={tool.status}>
          <button type="button" class="ai-step-row" aria-expanded={tool.expanded} onclick={() => { tool.expanded = !tool.expanded; refresh(); }}>
            <span class="ai-step-text"><span class="ai-step-title">{info?.title ?? tool.name}</span>{#if detail}<span class="ai-step-detail">{detail}</span>{/if}</span>
            {#if tool.status === 'streaming' || tool.status === 'running'}
              <span class="ai-spinner" aria-label={statusLabel(tool.status)}></span>
            {:else}
              {#if tool.status !== 'done'}<span class="ai-step-status">{statusLabel(tool.status)}</span>{/if}
              <svg class="ai-step-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
            {/if}
          </button>
          {#if tool.expanded}
            <div class="ai-step-details" transition:slide={{ duration: 200, easing: cubicOut }}>
              {#if tool.helpers?.length}
                {#each tool.helpers as helper (helper.id)}
                  <p class="ai-step-helper" data-status={helper.status}>{helper.task} <span>Page {helper.page} · {helper.status === 'running' ? (helper.current || 'Starting') : helper.summary}</span></p>
                {/each}
              {/if}
              {#if tool.image}<img class="ai-step-image" src={tool.image} alt={`Rendered page ${tool.args.page ?? ''}`} />{/if}
              <pre>{displayArgs(tool.args)}</pre>
              {#if tool.result}<pre class:error={tool.status === 'error'}>{prettyResult(tool.result)}</pre>{/if}
            </div>
          {/if}
        </div>
      {/snippet}
      <div class="ai-thread">
        {#each blocks as block (block.id)}
          {#if block.kind === 'entry' && block.entry.role === 'user'}
            {@const entry = block.entry}
            <div class="ai-user" in:fly={{ y: 8, duration: 220, easing: cubicOut }}>
              {#if entry.quote}
                <p class="ai-quote">{#if entry.quote.page}<span>P{entry.quote.page}</span>{/if}{entry.quote.text}</p>
              {/if}
              {#if entry.images.length}
                <div class="ai-user-images">
                  {#each entry.images as image, index (index)}<img src={image} alt="Attached" />{/each}
                </div>
              {/if}
              {#if entry.text}<p class="ai-user-text">{entry.text}</p>{/if}
            </div>
          {:else if block.kind === 'work'}
            {@const running = block.steps.some((step) => step.streaming || step.tools.some((tool) => tool.status === 'running' || tool.status === 'streaming'))}
            {@const tools = block.steps.flatMap((step) => step.tools)}
            {@const failed = tools.filter((tool) => tool.status === 'error').length}
            {@const started = block.request?.startedAt}
            {@const elapsed = started ? (running ? now : (block.request?.doneAt ?? 0)) - started : 0}
            {@const expanded = openWork.has(block.id)}
            <div class="ai-work" class:expanded>
              <button type="button" class="ai-work-line" class:live={running} aria-expanded={expanded} onclick={() => toggleWork(block.id)}>
                <!-- One string: Svelte trims spaces at the edges of {#if} blocks, which glued "Working·8s". -->
                <span class="ai-work-label">{running ? `${currentStep(block.steps)}${elapsed > 0 ? ` · ${duration(elapsed)}` : ''}` : elapsed > 0 ? `Worked for ${duration(elapsed)}` : 'Worked'}</span>
                {#if tools.length}<span class="ai-work-count">{`· ${tools.length} ${tools.length === 1 ? 'step' : 'steps'}${failed ? ` · ${failed} failed` : ''}`}</span>{/if}
                {#if tools.length}<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>{/if}
              </button>
              {#if expanded}
                <div class="ai-work-log" transition:slide={{ duration: 220, easing: cubicOut }}>
                  {#each tools as tool (tool.id)}{@render toolStep(tool)}{/each}
                </div>
              {/if}
              {#each tools.filter((tool) => tool.status === 'approval') as tool (tool.id)}
                <div class="ai-approval" transition:slide={{ duration: 200, easing: cubicOut }}>
                  <p>{approvalText(tool)}</p>
                  <div class="ai-actions">
                    <button type="button" class="ai-action secondary" onclick={() => answerApproval(tool.id, false)}>Deny</button>
                    <button type="button" class="ai-action" onclick={() => answerApproval(tool.id, true)}>Allow</button>
                  </div>
                </div>
              {/each}
            </div>
          {:else if block.kind === 'answer'}
            <div class="ai-markdown" class:streaming={block.entry.streaming}>{@html renderMarkdown(block.entry.text, mathTick)}</div>
          {:else if block.kind === 'entry' && block.entry.role === 'note'}
            <p class="ai-note" in:fade={{ duration: 160 }}><span>{block.entry.text}</span></p>
          {:else if block.kind === 'entry'}
            {@const entry = block.entry}
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
    <div class="ai-input">
      {#if selectionQuote || attachments.length}
        <div class="ai-chips" transition:slide={{ duration: 180, easing: cubicOut }}>
          {#if selectionQuote}
            <div class="ai-chip quote">
              <span>{#if selectionQuote.page}<em>P{selectionQuote.page}</em>{/if}{selectionQuote.text}</span>
              <button type="button" aria-label="Remove selected text" onclick={() => { usedSelection = selectionQuote?.text ?? ''; selectionQuote = null; }}></button>
            </div>
          {/if}
          {#each attachments as image, index (image)}
            <div class="ai-chip image">
              <img src={image} alt="Attachment" />
              <button type="button" aria-label="Remove image" onclick={() => (attachments = attachments.filter((_, item) => item !== index))}></button>
            </div>
          {/each}
        </div>
      {/if}
      <textarea
        bind:this={input}
        bind:value={draft}
        rows="1"
        placeholder={busy ? 'Working… Esc to stop' : 'Ask anything'}
        aria-label="Message"
        disabled={!status?.available}
        oninput={autosize}
        onkeydown={handleKeydown}
        onpaste={handlePaste}
      ></textarea>
      <div class="ai-input-bar">
        <button class="ai-bar-button" type="button" aria-label="Attach image" title="Attach image" disabled={!status?.available || busy} onclick={() => fileInput?.click()}>
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 4.5v15M4.5 12h15" /></svg>
        </button>
        <div class="ai-model-picker">
          <button class="ai-model" class:open={modelMenuOpen} type="button" aria-haspopup="menu" aria-expanded={modelMenuOpen} disabled={!models.length} onclick={(event) => { event.stopPropagation(); modelMenuOpen = !modelMenuOpen; }}>
            <span>{modelLabel}</span>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
          </button>
          {#if modelMenuOpen}
            <div class="ai-model-menu" role="menu" transition:fly={{ y: 6, duration: 160, easing: cubicOut }}>
              {#each models as model (model.id)}
                <button type="button" role="menuitemradio" aria-checked={model.id === selectedModel} class:active={model.id === selectedModel} onclick={(event) => { event.stopPropagation(); chooseModel(model.id); }}>
                  <span>{model.name}</span>
                  {#if model.id === selectedModel}<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" /></svg>{/if}
                </button>
              {/each}
              {#if usage.tokens}<p class="ai-usage">{usage.tokens.toLocaleString()} tokens · ${usage.cost.toFixed(usage.cost < 0.01 ? 4 : 3)}</p>{/if}
            </div>
          {/if}
        </div>
        {#if busy}
          <button class="ai-send stop" type="button" aria-label="Stop" title="Stop (Esc)" onclick={stop} in:fade={{ duration: 120 }}><span></span></button>
        {:else}
          <button class="ai-send" type="button" aria-label="Send" title="Send (Enter)" disabled={(!draft.trim() && !attachments.length) || !status?.available} onclick={() => send()} in:fade={{ duration: 120 }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" /></svg>
          </button>
        {/if}
      </div>
    </div>
  </footer>
  <input bind:this={fileInput} class="ai-file-input" type="file" accept="image/*" multiple onchange={(event) => { void addImages([...(event.currentTarget.files ?? [])]); event.currentTarget.value = ''; }} />
</aside>

<style>
  /*
   * Same card, header and fields as the editor's right-hand panels.
   * Two voices: Geist for what people and the AI say (black), Geist Mono for
   * everything the app reports around it (grey).
   */
  .ai-panel {
    --ai-text: rgba(0, 0, 0, 0.85);
    --ai-muted: rgba(0, 0, 0, 0.45);
    --ai-line: rgba(0, 0, 0, 0.1);
    --ai-mono: "Geist Mono Variable", "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    /* Docked in the shell's right padding (DocuflexApp .ai-docked), the full height of the window. */
    position: absolute;
    z-index: 7;
    top: 0;
    right: 0;
    bottom: 0;
    display: grid;
    grid-template-rows: 56px minmax(0, 1fr) auto;
    /*
     * The panel is as wide as the reserved space (0 to 440px) and clips; the
     * content keeps a fixed 440px column pinned to the right, so opening reads
     * as a drawer sliding in, and nothing sticks out past the window.
     */
    grid-template-columns: 438.5px;
    justify-content: end;
    box-sizing: border-box;
    width: var(--ai-dock, 0px);
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    border-left: 1.5px solid #c3c2c2;
    background: #f4f4f3;
    color: var(--ai-text);
    font-family: "Geist Variable", Geist, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 17px;
    letter-spacing: -0.17px;
    opacity: 0;
    visibility: hidden;
    transition: opacity 220ms ease, visibility 0s linear 280ms;
    -webkit-font-smoothing: antialiased;
  }

  .ai-panel.open {
    opacity: 1;
    visibility: visible;
    transition: opacity 220ms ease, visibility 0s;
  }


  button { font: inherit; letter-spacing: inherit; }

  svg path { stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }

  /* Everything sits above the character field (AiFieldBackground). */
  .ai-header,
  .ai-scroll,
  .ai-composer {
    position: relative;
    z-index: 1;
  }

  /* ---- Header ---- */
  .ai-header {
    display: grid;
    grid-template-columns: 24px minmax(0, 1fr) 36px 36px 36px;
    align-items: center;
    gap: 2px;
    box-sizing: border-box;
    height: 56px;
    padding: 0 10px 0 16px;
    border-bottom: 1.5px solid #c3c2c2;
    background: rgba(214, 214, 214, 0.75);
  }

  .ai-header > img { width: 24px; height: 24px; }

  .ai-header h2 {
    margin: 0 0 0 8px;
    overflow: hidden;
    color: #000;
    font-size: 20px;
    font-weight: 400;
    line-height: 1.22;
    letter-spacing: -0.2px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ai-header-button,
  .ai-bar-button {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    padding: 0;
    border: 0;
    border-radius: 10px;
    background: transparent;
    color: #818181;
    cursor: pointer;
    transition: background-color 150ms ease, color 150ms ease;
  }

  .ai-header-button:hover:not(:disabled),
  .ai-header-button.active,
  .ai-bar-button:hover:not(:disabled) {
    background: rgba(0, 0, 0, 0.06);
    color: #000;
  }

  .ai-header-button:disabled,
  .ai-bar-button:disabled { cursor: default; opacity: 0.35; }

  .ai-close {
    width: 36px;
    height: 36px;
    padding: 0;
    border: 0;
    border-radius: 10px;
    background: url('/redesign/tab-close.svg') center / 14.4px 14.4px no-repeat;
    cursor: pointer;
    transition: transform 160ms ease, filter 160ms ease;
  }

  .ai-close:hover { filter: brightness(0.6); }
  .ai-close:active { transform: scale(0.94); }

  /* ---- Scroll area ---- */
  .ai-scroll {
    min-height: 0;
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: none;
  }

  .ai-scroll::-webkit-scrollbar { display: none; }

  .ai-scroll-content { padding: 15px 14px 18px; }


  /* ---- Empty state, history: rows at the panels' 48px / 21px ---- */
  .ai-empty { display: grid; gap: 14px; }

  .ai-list { display: grid; gap: 8px; }

  .ai-list-empty { margin: 4px 3px; color: var(--ai-muted); }

  .ai-divider { width: 100%; height: 1px; margin: 0; border: 0; background: var(--ai-line); }

  .ai-suggestion,
  .ai-chat-row {
    box-sizing: border-box;
    min-height: 44px;
    border: 1px solid var(--ai-line);
    border-radius: 14px;
    background: #fff;
    transition: background-color 150ms ease, border-color 150ms ease;
  }

  .ai-suggestion {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 0 13px;
    color: var(--ai-text);
    text-align: left;
    cursor: pointer;
  }

  .ai-suggestion img { width: 21px; height: 21px; opacity: 0.85; }
  .ai-suggestion:hover:not(:disabled) { background: #f2f2f2; }
  .ai-suggestion:disabled { cursor: default; opacity: 0.5; }

  /* Title only; on hover the row darkens 5% and the title fades out under the cross. */
  .ai-chat-row { position: relative; overflow: hidden; }
  .ai-chat-row:hover { background: #f2f2f2; }
  .ai-chat-row.current { border-color: rgba(0, 0, 0, 0.22); }

  .ai-chat-open {
    display: flex;
    align-items: center;
    width: 100%;
    height: 42px;
    padding: 0 13px;
    border: 0;
    background: transparent;
    color: var(--ai-text);
    text-align: left;
    cursor: pointer;
  }

  .ai-chat-open:disabled { cursor: default; }

  .ai-chat-title {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
  }

  .ai-chat-title:global(.clipped) {
    -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 28px), transparent);
    mask-image: linear-gradient(90deg, #000 calc(100% - 28px), transparent);
  }

  .ai-chat-row:hover .ai-chat-title.ai-chat-title,
  .ai-chat-row:focus-within .ai-chat-title.ai-chat-title {
    -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 92px), transparent calc(100% - 44px));
    mask-image: linear-gradient(90deg, #000 calc(100% - 92px), transparent calc(100% - 44px));
  }

  .ai-chat-delete {
    position: absolute;
    top: 50%;
    right: 6px;
    width: 36px;
    height: 36px;
    padding: 0;
    border: 0;
    border-radius: 10px;
    background: url('/redesign/tab-close.svg') center / 14.4px 14.4px no-repeat;
    opacity: 0;
    transform: translateY(-50%);
    cursor: pointer;
    transition: opacity 150ms ease, filter 150ms ease;
  }

  .ai-chat-row:hover .ai-chat-delete,
  .ai-chat-delete:focus-visible { opacity: 1; }
  .ai-chat-delete:hover { filter: brightness(0.6); }

  /* ---- Thread ---- */
  .ai-thread { display: grid; gap: 14px; }

  /* A request starts a new section: more air above each message. */
  .ai-thread > .ai-user:not(:first-child) { margin-top: 14px; }

  .ai-user {
    display: grid;
    justify-items: end;
    gap: 6px;
    margin-left: 44px;
  }

  .ai-user-text {
    margin: 0;
    padding: 10px 14px;
    border-radius: 16px;
    background: rgba(0, 0, 0, 0.055);
    color: var(--ai-text);
    line-height: 1.42;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  .ai-quote,
  .ai-chip.quote span {
    display: -webkit-box;
    overflow: hidden;
    color: var(--ai-muted);
    line-height: 1.45;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }

  .ai-quote {
    margin: 0;
    padding-left: 10px;
    border-left: 2px solid rgba(0, 0, 0, 0.14);
    text-align: left;
  }

  .ai-quote span,
  .ai-chip.quote em { margin-right: 7px; color: rgba(0, 0, 0, 0.7); font-style: normal; }

  .ai-user-images { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }

  .ai-user-images img {
    max-width: 120px;
    max-height: 90px;
    border: 1px solid var(--ai-line);
    border-radius: 11px;
    object-fit: cover;
  }

  /*
   * Each request's work folds into one quiet line; it opens into the step log.
   * While it runs, the line names the current step and shimmers.
   */
  .ai-work { display: grid; gap: 8px; min-width: 0; }

  .ai-work-line {
    display: inline-flex;
    align-items: center;
    justify-self: start;
    gap: 6px;
    max-width: 100%;
    padding: 0;
    border: 0;
    background: none;
    color: var(--ai-muted);
    cursor: pointer;
    transition: color 150ms ease;
  }

  .ai-work-line:hover { color: rgba(0, 0, 0, 0.8); }
  .ai-work-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ai-work-count { flex: none; }
  .ai-work-line svg { flex: none; transition: transform 180ms ease; }
  .ai-work.expanded .ai-work-line svg { transform: rotate(180deg); }

  .ai-work-line.live .ai-work-label {
    background: linear-gradient(90deg, rgba(0, 0, 0, 0.35) 0%, rgba(0, 0, 0, 0.8) 50%, rgba(0, 0, 0, 0.35) 100%) 0 0 / 200% 100%;
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    animation: ai-shimmer 1.6s linear infinite;
  }

  /* The opened log: one rounded box, a plain row per step. */
  .ai-work-log {
    display: grid;
    min-width: 0;
    overflow: hidden;
    border: 1px solid var(--ai-line);
    border-radius: 14px;
  }

  @keyframes ai-shimmer {
    from { background-position: 100% 0; }
    to { background-position: -100% 0; }
  }


  /* ---- Answer text ---- */
  .ai-markdown {
    min-width: 0;
    color: var(--ai-text);
    line-height: 1.55;
    overflow-wrap: anywhere;
  }

  .ai-markdown :global(.table-wrap) {
    margin: 0 0 10px;
    overflow-x: auto;
    border: 1px solid var(--ai-line);
    border-radius: 12px;
    background: #fff;
  }

  .ai-markdown :global(table) {
    width: 100%;
    border-collapse: collapse;
    line-height: 1.4;
    font-variant-numeric: tabular-nums;
  }

  .ai-markdown :global(th),
  .ai-markdown :global(td) {
    padding: 8px 12px;
    border-bottom: 1px solid var(--ai-line);
    text-align: left;
    white-space: nowrap;
  }

  .ai-markdown :global(th) {
    color: var(--ai-muted);
    font-weight: 400;
  }

  .ai-markdown :global(tr:last-child td) { border-bottom: 0; }

  .ai-markdown :global(p),
  .ai-markdown :global(ul),
  .ai-markdown :global(ol),
  .ai-markdown :global(pre),
  .ai-markdown :global(blockquote),
  .ai-markdown :global(h3),
  .ai-markdown :global(h4),
  .ai-markdown :global(h5),
  .ai-markdown :global(h6) {
    margin: 0 0 10px;
  }

  .ai-markdown > :global(:last-child) { margin-bottom: 0; }

  .ai-markdown :global(h3),
  .ai-markdown :global(h4),
  .ai-markdown :global(h5),
  .ai-markdown :global(h6) {
    color: #000;
    font-size: 17px;
    font-weight: 560;
  }

  .ai-markdown :global(strong) { color: #000; font-weight: 560; }
  .ai-markdown :global(ul),
  .ai-markdown :global(ol) { padding-left: 21px; }
  .ai-markdown :global(li + li) { margin-top: 4px; }

  /* LaTeX rendered by MathJax as SVG in TeX's own fonts; it inherits the text colour. */
  .ai-markdown :global(.math) {
    display: inline-block;
    max-width: 100%;
    overflow-x: auto;
    overflow-y: hidden;
    vertical-align: middle;
    line-height: 0;
  }

  .ai-markdown :global(.math svg) {
    max-width: none;
    font-size: 108%;
  }

  .ai-markdown :global(.math.display) {
    display: block;
    margin: 10px 0;
    padding: 4px 0;
    text-align: center;
  }

  .ai-markdown :global(.math.display svg) { font-size: 112%; }
  .ai-markdown :global(.math.pending),
  .ai-markdown :global(.math.invalid) { line-height: inherit; }
  .ai-markdown :global(.math.pending code) { opacity: 0.55; }
  .ai-markdown :global(.math.invalid code) { color: #c83e3e; }

  .ai-markdown :global(code) {
    padding: 1px 5px;
    border-radius: 6px;
    background: rgba(0, 0, 0, 0.05);
    font-family: var(--ai-mono);
    font-size: 15.5px;
    letter-spacing: 0;
  }

  .ai-markdown :global(pre) {
    overflow-x: auto;
    padding: 11px 13px;
    border: 1px solid var(--ai-line);
    border-radius: 12px;
    background: #fff;
  }

  .ai-markdown :global(pre code) { padding: 0; background: none; }

  .ai-markdown :global(blockquote) {
    padding-left: 10px;
    border-left: 2px solid rgba(0, 0, 0, 0.14);
    color: var(--ai-muted);
  }

  .ai-markdown :global(a) { color: #1684f8; text-decoration: none; }
  .ai-markdown :global(a:hover) { text-decoration: underline; }
  .ai-markdown :global(hr) { height: 1px; margin: 14px 0; border: 0; background: var(--ai-line); }

  .ai-markdown.streaming > :global(:last-child)::after {
    display: inline-block;
    width: 7px;
    height: 15px;
    margin-left: 3px;
    border-radius: 2px;
    background: rgba(0, 0, 0, 0.7);
    vertical-align: -2px;
    content: '';
    animation: ai-caret 1s steps(1) infinite;
  }

  @keyframes ai-caret { 50% { opacity: 0; } }

  /* ---- Steps ---- */
  .ai-step { min-width: 0; }
  .ai-step + .ai-step { border-top: 1px solid var(--ai-line); }

  .ai-step-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 44px;
    padding: 0 14px;
    border: 0;
    background: none;
    color: var(--ai-muted);
    text-align: left;
    cursor: pointer;
    transition: background-color 150ms ease, color 150ms ease;
  }

  .ai-step-row:hover { background: rgba(0, 0, 0, 0.03); color: rgba(0, 0, 0, 0.8); }

  .ai-step-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ai-step-detail { margin-left: 0.3em; color: rgba(0, 0, 0, 0.35); }
  .ai-step-status { flex: none; margin-left: auto; color: rgba(0, 0, 0, 0.35); }
  .ai-step-chevron { flex: none; color: rgba(0, 0, 0, 0.35); transition: transform 160ms ease; }
  .ai-step-status + .ai-step-chevron { margin-left: 0; }
  .ai-step-text + .ai-step-chevron { margin-left: 0; }
  .ai-step.expanded .ai-step-chevron { transform: rotate(90deg); }
  .ai-step[data-status='error'] .ai-step-status { color: #de3542; }
  .ai-step[data-status='denied'] .ai-step-title,
  .ai-step[data-status='cancelled'] .ai-step-title { text-decoration: line-through; }

  .ai-spinner {
    flex: none;
    box-sizing: border-box;
    width: 15px;
    height: 15px;
    margin-left: auto;
    border: 1.5px solid rgba(0, 0, 0, 0.14);
    border-top-color: rgba(0, 0, 0, 0.6);
    border-radius: 50%;
    animation: ai-spin 700ms linear infinite;
  }

  @keyframes ai-spin { to { transform: rotate(360deg); } }

  .ai-step-details { display: grid; gap: 8px; padding: 0 14px 14px; }

  .ai-step-helper { margin: 0; color: rgba(0, 0, 0, 0.7); line-height: 1.45; }
  .ai-step-helper span { color: var(--ai-muted); }
  .ai-step-helper[data-status='error'] span { color: #de3542; }

  .ai-step-image {
    display: block;
    max-width: 100%;
    border: 1px solid var(--ai-line);
    border-radius: 10px;
  }

  .ai-approval {
    display: grid;
    gap: 10px;
    margin: 0;
    padding: 12px 13px;
    border: 1px solid var(--ai-line);
    border-radius: 15px;
    background: #fff;
  }

  .ai-approval p { margin: 0; line-height: 1.42; }

  .ai-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }

  .ai-action {
    height: 40px;
    padding: 0 16px;
    border: 1px solid #111;
    border-radius: 12px;
    background: #111;
    color: #fff;
    cursor: pointer;
    transition: background-color 150ms ease, transform 160ms ease;
  }

  .ai-action:active { transform: scale(0.97); }

  .ai-action.secondary {
    border-color: var(--ai-line);
    background: #fff;
    color: var(--ai-text);
  }

  .ai-action.secondary:hover { background: rgba(0, 0, 0, 0.04); }





  .ai-step-details pre {
    max-height: 200px;
    margin: 0;
    overflow: auto;
    padding: 10px 12px;
    border: 1px solid var(--ai-line);
    border-radius: 12px;
    background: #fff;
    color: rgba(0, 0, 0, 0.6);
    font-family: var(--ai-mono);
    font-size: 15px;
    letter-spacing: 0;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .ai-step-details pre.error { color: #de3542; }

  /* Notes read like a divider: ——— CHAT RESUMED ——— */
  .ai-note {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 4px 0;
    color: var(--ai-muted);
    text-align: center;
  }

  .ai-note::before,
  .ai-note::after { flex: 1; height: 1px; background: var(--ai-line); content: ''; }

  .ai-error {
    display: grid;
    justify-items: start;
    gap: 10px;
  }

  .ai-error p {
    margin: 0;
    color: #de3542;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }

  /* ---- Composer ---- */
  .ai-composer { padding: 0 11px 11px 12px; }

  .ai-input {
    display: grid;
    gap: 2px;
    padding: 6px 7px 7px;
    border: 1px solid var(--ai-line);
    border-radius: 15px;
    background: #fff;
    transition: border-color 160ms ease;
  }

  .ai-input:focus-within { border-color: rgba(0, 0, 0, 0.22); }
  .ai-panel.dragging .ai-input { border-color: #1684f8; }

  .ai-input textarea {
    box-sizing: border-box;
    width: 100%;
    max-height: 180px;
    min-height: 34px;
    margin: 0;
    padding: 7px 6px 4px;
    border: 0;
    outline: 0;
    resize: none;
    background: transparent;
    color: var(--ai-text);
    font: inherit;
    line-height: 1.42;
  }

  .ai-input textarea::placeholder { color: rgba(0, 0, 0, 0.4); }
  .ai-input textarea:disabled { cursor: default; }

  /* One row of 36px controls: same height, radius, grey and stroke for the plus, the model and its chevron. */
  .ai-input-bar {
    display: grid;
    grid-template-columns: 36px minmax(0, 1fr) 36px;
    align-items: center;
    gap: 4px;
  }

  .ai-input-bar svg path { stroke-width: 1.6; }
  .ai-bar-button { border-radius: 11px; }

  .ai-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 2px 2px 4px; }

  .ai-chip {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    border-radius: 10px;
    background: rgba(0, 0, 0, 0.04);
  }

  .ai-chip.quote { flex: 1 1 100%; padding: 7px 34px 7px 10px; }
  .ai-chip.image { padding: 3px; }
  .ai-chip.image img { display: block; width: 52px; height: 52px; border-radius: 8px; object-fit: cover; }

  .ai-chip button {
    position: absolute;
    top: 5px;
    right: 5px;
    width: 22px;
    height: 22px;
    padding: 0;
    border: 0;
    border-radius: 7px;
    background: url('/redesign/panel-close.svg') center / 9px 9px no-repeat;
    cursor: pointer;
  }

  .ai-chip.image button { top: 2px; right: 2px; background-color: rgba(255, 255, 255, 0.9); }
  .ai-chip button:hover { filter: brightness(0); }

  .ai-model-picker { position: relative; justify-self: end; min-width: 0; }

  .ai-model {
    display: flex;
    align-items: center;
    gap: 5px;
    max-width: 100%;
    height: 36px;
    padding: 0 7px 0 11px;
    border: 0;
    border-radius: 11px;
    background: transparent;
    color: #818181;
    font-family: var(--ai-mono);
    font-size: 16px;
    letter-spacing: -0.2px;
    line-height: 1;
    cursor: pointer;
    transition: background-color 150ms ease, color 150ms ease;
  }

  .ai-model span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ai-model:hover:not(:disabled),
  .ai-model.open { background: rgba(0, 0, 0, 0.05); color: #000; }
  .ai-model svg { flex: none; transition: transform 160ms ease; }
  .ai-model.open svg { transform: rotate(180deg); }

  /* Same frosted menu as the toolbar's tool menus. */
  .ai-model-menu {
    position: absolute;
    z-index: 5;
    right: -42px;
    bottom: calc(100% + 10px);
    display: grid;
    width: 270px;
    padding: 5px;
    border: 1px solid rgba(0, 0, 0, 0.14);
    border-radius: 15px;
    background: rgba(255, 255, 255, 0.92);
    box-shadow: 0 7px 18px rgba(0, 0, 0, 0.11), 0 2px 5px rgba(0, 0, 0, 0.05);
    backdrop-filter: blur(18px);
    -webkit-backdrop-filter: blur(18px);
  }

  .ai-model-menu button {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 38px;
    padding: 0 10px;
    border: 1px solid transparent;
    border-radius: 10px;
    background: transparent;
    color: rgba(0, 0, 0, 0.75);
    text-align: left;
    cursor: pointer;
  }

  .ai-model-menu button:hover { color: #000; background: rgba(0, 0, 0, 0.04); }
  .ai-model-menu button.active { border-color: rgba(0, 0, 0, 0.06); background: rgba(234, 234, 234, 0.6); color: #000; }

  .ai-usage {
    margin: 4px 0 0;
    padding: 8px 10px 4px;
    border-top: 1px solid var(--ai-line);
    color: var(--ai-muted);
    font-family: var(--ai-mono);
    font-size: 12px;
    letter-spacing: 0;
  }

  .ai-send {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    padding: 0;
    border: 0;
    border-radius: 11px;
    background: #111;
    color: #fff;
    cursor: pointer;
    transition: opacity 150ms ease, transform 160ms ease;
  }

  .ai-send svg path { stroke-width: 1.9; }
  .ai-send:active:not(:disabled) { transform: scale(0.94); }
  .ai-send:disabled { cursor: default; opacity: 0.2; }
  .ai-send.stop span { width: 11px; height: 11px; border-radius: 3px; background: #fff; }

  .ai-file-input { display: none; }

  @media (prefers-reduced-motion: reduce) {
    .ai-panel,
    .ai-panel.open { transition: none; }
    .ai-work-line.live .ai-work-label,
    .ai-spinner,
    .ai-markdown.streaming > :global(:last-child)::after { animation: none; }
  }

  /* dark theme: generated by scripts/generate-dark-theme.mjs — do not edit */
  :global(:root[data-theme="dark"]) .ai-panel { --ai-text: rgba(255, 255, 255, 0.85); --ai-muted: rgba(255, 255, 255, 0.45); --ai-line: rgba(255, 255, 255, 0.08); border-left: 1.5px solid #2c2c2c; background: #121212; color: var(--ai-text); }
  :global(:root[data-theme="dark"]) svg path { stroke: currentColor; }
  :global(:root[data-theme="dark"]) .ai-header { border-bottom: 1.5px solid #2c2c2c; background: rgba(0, 0, 0, 0.45); }
  :global(:root[data-theme="dark"]) .ai-header h2 { color: rgba(255, 255, 255, 0.92); }
  :global(:root[data-theme="dark"]) .ai-header-button,
  :global(:root[data-theme="dark"]) .ai-bar-button { border: 0; background: transparent; color: rgba(255, 255, 255, 0.494); }
  :global(:root[data-theme="dark"]) .ai-header-button:hover:not(:disabled),
  :global(:root[data-theme="dark"]) .ai-header-button.active,
  :global(:root[data-theme="dark"]) .ai-bar-button:hover:not(:disabled) { background: rgba(255, 255, 255, 0.078); color: rgba(255, 255, 255, 0.92); }
  :global(:root[data-theme="dark"]) .ai-close { border: 0; filter: brightness(0) invert(1) opacity(0.78); background: url('/redesign/tab-close.svg') center / 14.4px 14.4px no-repeat; }
  :global(:root[data-theme="dark"]) .ai-list-empty { color: var(--ai-muted); }
  :global(:root[data-theme="dark"]) .ai-divider { border: 0; background: var(--ai-line); }
  :global(:root[data-theme="dark"]) .ai-suggestion,
  :global(:root[data-theme="dark"]) .ai-chat-row { border: 1px solid var(--ai-line); background: rgba(255, 255, 255, 0.05); }
  :global(:root[data-theme="dark"]) .ai-suggestion { color: var(--ai-text); }
  :global(:root[data-theme="dark"]) .ai-suggestion:hover:not(:disabled) { background: #121212; }
  :global(:root[data-theme="dark"]) .ai-chat-row:hover { background: #121212; }
  :global(:root[data-theme="dark"]) .ai-chat-row.current { border-color: rgba(255, 255, 255, 0.176); }
  :global(:root[data-theme="dark"]) .ai-chat-open { border: 0; background: transparent; color: var(--ai-text); }
  :global(:root[data-theme="dark"]) .ai-chat-delete { border: 0; filter: brightness(0) invert(1) opacity(0.78); background: url('/redesign/tab-close.svg') center / 14.4px 14.4px no-repeat; }
  :global(:root[data-theme="dark"]) .ai-user-text { background: rgba(255, 255, 255, 0.072); color: var(--ai-text); }
  :global(:root[data-theme="dark"]) .ai-quote,
  :global(:root[data-theme="dark"]) .ai-chip.quote span { color: var(--ai-muted); }
  :global(:root[data-theme="dark"]) .ai-quote { border-left: 2px solid rgba(255, 255, 255, 0.112); }
  :global(:root[data-theme="dark"]) .ai-quote span,
  :global(:root[data-theme="dark"]) .ai-chip.quote em { color: rgba(255, 255, 255, 0.7); }
  :global(:root[data-theme="dark"]) .ai-user-images img { border: 1px solid var(--ai-line); }
  :global(:root[data-theme="dark"]) .ai-work-line { border: 0; background: none; color: var(--ai-muted); }
  :global(:root[data-theme="dark"]) .ai-work-line:hover { color: rgba(255, 255, 255, 0.8); }
  :global(:root[data-theme="dark"]) .ai-work-line.live .ai-work-label { background: linear-gradient(90deg, rgba(255, 255, 255, 0.2) 0%, rgba(255, 255, 255, 0.2) 50%, rgba(255, 255, 255, 0.2) 100%) 0 0 / 200% 100%; color: transparent; -webkit-background-clip: text; background-clip: text; }
  :global(:root[data-theme="dark"]) .ai-work-log { border: 1px solid var(--ai-line); }
  :global(:root[data-theme="dark"]) .ai-markdown { color: var(--ai-text); }
  :global(:root[data-theme="dark"]) .ai-markdown :global(.table-wrap) { border: 1px solid var(--ai-line); background: rgba(255, 255, 255, 0.05); }
  :global(:root[data-theme="dark"]) .ai-markdown :global(th),
  :global(:root[data-theme="dark"]) .ai-markdown :global(td) { border-bottom: 1px solid var(--ai-line); }
  :global(:root[data-theme="dark"]) .ai-markdown :global(th) { color: var(--ai-muted); }
  :global(:root[data-theme="dark"]) .ai-markdown :global(tr:last-child td) { border-bottom: 0; }
  :global(:root[data-theme="dark"]) .ai-markdown :global(h3),
  :global(:root[data-theme="dark"]) .ai-markdown :global(h4),
  :global(:root[data-theme="dark"]) .ai-markdown :global(h5),
  :global(:root[data-theme="dark"]) .ai-markdown :global(h6) { color: rgba(255, 255, 255, 0.92); }
  :global(:root[data-theme="dark"]) .ai-markdown :global(strong) { color: rgba(255, 255, 255, 0.92); }
  :global(:root[data-theme="dark"]) .ai-markdown :global(.math.invalid code) { color: #c83e3e; }
  :global(:root[data-theme="dark"]) .ai-markdown :global(code) { background: rgba(255, 255, 255, 0.065); }
  :global(:root[data-theme="dark"]) .ai-markdown :global(pre) { border: 1px solid var(--ai-line); background: rgba(255, 255, 255, 0.05); }
  :global(:root[data-theme="dark"]) .ai-markdown :global(pre code) { background: none; }
  :global(:root[data-theme="dark"]) .ai-markdown :global(blockquote) { border-left: 2px solid rgba(255, 255, 255, 0.112); color: var(--ai-muted); }
  :global(:root[data-theme="dark"]) .ai-markdown :global(a) { color: #1684f8; text-decoration: none; }
  :global(:root[data-theme="dark"]) .ai-markdown :global(a:hover) { text-decoration: underline; }
  :global(:root[data-theme="dark"]) .ai-markdown :global(hr) { border: 0; background: var(--ai-line); }
  :global(:root[data-theme="dark"]) .ai-markdown.streaming > :global(:last-child)::after { background: rgba(255, 255, 255, 0.2); }
  :global(:root[data-theme="dark"]) .ai-step + .ai-step { border-top: 1px solid var(--ai-line); }
  :global(:root[data-theme="dark"]) .ai-step-row { border: 0; background: none; color: var(--ai-muted); }
  :global(:root[data-theme="dark"]) .ai-step-row:hover { background: rgba(255, 255, 255, 0.039); color: rgba(255, 255, 255, 0.8); }
  :global(:root[data-theme="dark"]) .ai-step-detail { color: rgba(255, 255, 255, 0.35); }
  :global(:root[data-theme="dark"]) .ai-step-status { color: rgba(255, 255, 255, 0.35); }
  :global(:root[data-theme="dark"]) .ai-step-chevron { color: rgba(255, 255, 255, 0.35); }
  :global(:root[data-theme="dark"]) .ai-step[data-status='error'] .ai-step-status { color: #de3542; }
  :global(:root[data-theme="dark"]) .ai-step[data-status='denied'] .ai-step-title,
  :global(:root[data-theme="dark"]) .ai-step[data-status='cancelled'] .ai-step-title { text-decoration: line-through; }
  :global(:root[data-theme="dark"]) .ai-spinner { border: 1.5px solid rgba(255, 255, 255, 0.112); border-top-color: rgba(255, 255, 255, 0.48); }
  :global(:root[data-theme="dark"]) .ai-step-helper { color: rgba(255, 255, 255, 0.7); }
  :global(:root[data-theme="dark"]) .ai-step-helper span { color: var(--ai-muted); }
  :global(:root[data-theme="dark"]) .ai-step-helper[data-status='error'] span { color: #de3542; }
  :global(:root[data-theme="dark"]) .ai-step-image { border: 1px solid var(--ai-line); }
  :global(:root[data-theme="dark"]) .ai-approval { border: 1px solid var(--ai-line); background: rgba(255, 255, 255, 0.05); }
  :global(:root[data-theme="dark"]) .ai-action { border: 1px solid #ececec; background: #ececec; color: #111111; }
  :global(:root[data-theme="dark"]) .ai-action.secondary { border-color: var(--ai-line); background: rgba(255, 255, 255, 0.05); color: var(--ai-text); }
  :global(:root[data-theme="dark"]) .ai-action.secondary:hover { background: rgba(255, 255, 255, 0.052); }
  :global(:root[data-theme="dark"]) .ai-step-details pre { border: 1px solid var(--ai-line); background: rgba(255, 255, 255, 0.05); color: rgba(255, 255, 255, 0.6); }
  :global(:root[data-theme="dark"]) .ai-step-details pre.error { color: #de3542; }
  :global(:root[data-theme="dark"]) .ai-note { color: var(--ai-muted); }
  :global(:root[data-theme="dark"]) .ai-note::before,
  :global(:root[data-theme="dark"]) .ai-note::after { background: var(--ai-line); }
  :global(:root[data-theme="dark"]) .ai-error p { color: #de3542; }
  :global(:root[data-theme="dark"]) .ai-input { border: 1px solid var(--ai-line); background: rgba(255, 255, 255, 0.05); }
  :global(:root[data-theme="dark"]) .ai-input:focus-within { border-color: rgba(255, 255, 255, 0.176); }
  :global(:root[data-theme="dark"]) .ai-panel.dragging .ai-input { border-color: #1684f8; }
  :global(:root[data-theme="dark"]) .ai-input textarea { border: 0; outline: 0; background: transparent; color: var(--ai-text); }
  :global(:root[data-theme="dark"]) .ai-input textarea::placeholder { color: rgba(255, 255, 255, 0.4); }
  :global(:root[data-theme="dark"]) .ai-chip { background: rgba(255, 255, 255, 0.052); }
  :global(:root[data-theme="dark"]) .ai-chip button { border: 0; filter: brightness(0) invert(1) opacity(0.78); background: url('/redesign/panel-close.svg') center / 9px 9px no-repeat; }
  :global(:root[data-theme="dark"]) .ai-chip.image button { background-color: rgba(255, 255, 255, 0.07); }
  :global(:root[data-theme="dark"]) .ai-chip button:hover { filter: brightness(0) invert(1); }
  :global(:root[data-theme="dark"]) .ai-model { border: 0; background: transparent; color: rgba(255, 255, 255, 0.494); }
  :global(:root[data-theme="dark"]) .ai-model:hover:not(:disabled),
  :global(:root[data-theme="dark"]) .ai-model.open { background: rgba(255, 255, 255, 0.065); color: rgba(255, 255, 255, 0.92); }
  :global(:root[data-theme="dark"]) .ai-model-menu { border: 1px solid rgba(255, 255, 255, 0.112); background: rgba(24, 24, 24, 0.95); box-shadow: 0 7px 18px rgba(0, 0, 0, 0.33), 0 2px 5px rgba(0, 0, 0, 0.15); }
  :global(:root[data-theme="dark"]) .ai-model-menu button { border: 1px solid transparent; background: transparent; color: rgba(255, 255, 255, 0.75); }
  :global(:root[data-theme="dark"]) .ai-model-menu button:hover { color: rgba(255, 255, 255, 0.92); background: rgba(255, 255, 255, 0.052); }
  :global(:root[data-theme="dark"]) .ai-model-menu button.active { border-color: rgba(255, 255, 255, 0.048); background: rgba(22, 22, 22, 0.96); color: rgba(255, 255, 255, 0.92); }
  :global(:root[data-theme="dark"]) .ai-usage { border-top: 1px solid var(--ai-line); color: var(--ai-muted); }
  :global(:root[data-theme="dark"]) .ai-send { border: 0; background: #ececec; color: #111111; }
  :global(:root[data-theme="dark"]) .ai-send.stop span { background: rgba(255, 255, 255, 0.05); }
  /* dark theme: end generated */

</style>
