import { QWEN_MODEL_ID, qwenChat, qwenSupported } from '#lib/server/ollama.js';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as env from '$app/env/private';
import { mcpAvailable } from '#lib/server/mcp-bridge.js';
import { MCP_INSTRUCTIONS, MCP_TOOLS } from '#lib/server/mcp-tools.js';

/**
 * AI chat: an agent that edits the open documents with the same tools the
 * local MCP server exposes. Like the MCP server it only exists in the desktop
 * app and local development, and only when an OpenRouter key has been saved
 * from Settings (stored in ~/.docuflex/openrouter-key). The key never reaches
 * the window.
 */

export const AI_MODEL = env.DOCUFLEX_AI_MODEL || 'xiaomi/mimo-v2.6-flash';
/** Used by OpenRouter when the main model fails or is unavailable. */
export const AI_FALLBACK_MODEL = env.DOCUFLEX_AI_FALLBACK_MODEL || 'google/gemini-3-flash-preview';
/** Models the chat can switch between. Free entries use explicit free variants. */
export const AI_MODELS = [
  { id: AI_MODEL, name: 'MiMo V2.6 Flash', short: 'MiMo Flash' },
  { id: 'xiaomi/mimo-v2.6-pro', name: 'MiMo V2.6 Pro', short: 'MiMo Pro' },
  { id: 'google/gemini-4-argon', name: 'Gemini 4 Argon', short: 'Argon' },
  { id: 'google/gemini-3.8-flash', name: 'Gemini 3.8 Flash', short: 'Gemini Flash' },
  { id: 'anthropic/claude-haiku-5.5', name: 'Claude Haiku 5.5', short: 'Haiku' },
  { id: 'anthropic/claude-sonnet-5.5', name: 'Claude Sonnet 5.5', short: 'Sonnet' },
  { id: 'anthropic/claude-opus-5.5', name: 'Claude Opus 5.5', short: 'Opus' },
  { id: 'openai/gpt-6.1-sol', name: 'GPT-6.1 Sol', short: 'Sol' },
  { id: 'openai/gpt-6-luna', name: 'GPT-6 Luna', short: 'Luna' },
  { id: 'moonshotai/kimi-k3', name: 'Kimi K3', short: 'Kimi' },
  { id: 'openrouter/free', name: 'Free Models Router', short: 'Free Router', free: true },
  { id: 'dots-studio/dots-3-note-preview:free', name: 'Dots3-Note Preview', short: 'Dots3 Note', free: true },
  { id: 'nvidia/nemotron-3.5-lightning:free', name: 'Nemotron 3.5 Lightning', short: 'Nemotron Lightning', free: true },
  { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', name: 'Nemotron 3 Ultra', short: 'Nemotron Ultra', free: true }
].filter((model, index, list) => list.findIndex((other) => other.id === model.id) === index);
/** Free selections must never fall back to a paid model or provider. @param {string} model */
export function modelRouting(model) {
  if (AI_MODELS.some((candidate) => candidate.id === model && candidate.free)) {
    return { model, provider: { max_price: { prompt: 0, completion: 0, image: 0, request: 0 } } };
  }
  return { models: model === AI_FALLBACK_MODEL ? [model] : [model, AI_FALLBACK_MODEL] };
}

const KEY_FILE = join(homedir(), '.docuflex', 'openrouter-key');
const MEMORY_FILE = join(homedir(), '.docuflex', 'ai-memory.json');
/** Thinking budget per model turn. MiMo otherwise thinks for a long time on simple steps. */
const REASONING_TOKENS = 1024;

/** Tools that write files or discard work need the person's approval in the chat. */
export const AI_APPROVAL_TOOLS = new Set(['save_document', 'extract_pages', 'close_document']);

export async function openRouterKey() {
  try {
    return (await readFile(KEY_FILE, 'utf8')).trim() || null;
  } catch {
    return null;
  }
}

/** The last characters of the saved key, so Settings can show which key is in use. */
export async function openRouterKeyHint() {
  const key = await openRouterKey();
  return key ? key.slice(-4) : null;
}

/**
 * Checks the key with OpenRouter before saving it, readable only by this user.
 * @param {string} key
 */
export async function saveOpenRouterKey(key) {
  const trimmed = key.trim();
  if (!/^\S{20,300}$/.test(trimmed)) throw new Error('That doesn\'t look like an OpenRouter API key.');
  let response = null;
  try {
    response = await fetch('https://openrouter.ai/api/v1/key', {
      headers: { Authorization: `Bearer ${trimmed}` },
      signal: AbortSignal.timeout(8000)
    });
  } catch {
    // Offline: keep the key; the chat reports a bad key when it is used.
  }
  if (response && (response.status === 401 || response.status === 403)) throw new Error('OpenRouter rejected this key.');
  await mkdir(join(homedir(), '.docuflex'), { recursive: true });
  await writeFile(KEY_FILE, `${trimmed}\n`, { mode: 0o600 });
  await chmod(KEY_FILE, 0o600);
}

export async function deleteOpenRouterKey() {
  await rm(KEY_FILE, { force: true });
}

export async function aiAvailable() {
  return mcpAvailable() && (Boolean(await openRouterKey()) || await qwenSupported());
}

/** Tools only the AI chat has: its notes about documents. */
export const MEMORY_TOOLS = [
  {
    name: 'remember',
    title: 'Remember',
    description: 'Saves a short note about the active document for future chats: what the person wants, decisions, what you did and where (pages, object ids are not stable across sessions, so describe positions). Notes for the active document are shown to you automatically in every chat. Keep each note to one or two sentences.',
    inputSchema: { type: 'object', properties: { note: { type: 'string', minLength: 1, maxLength: 500 } }, required: ['note'] }
  },
  {
    name: 'forget',
    title: 'Forget',
    description: 'Deletes a saved note about the active document by its number, or all of them.',
    inputSchema: { type: 'object', properties: { number: { type: 'integer', minimum: 1 }, all: { type: 'boolean' } } }
  }
];

const region = {
  type: 'object',
  description: 'The helper\'s area on the page in points (x, y from the top-left, width, height). Leave out to give it the whole page.',
  properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } },
  required: ['x', 'y', 'width', 'height']
};

/** Only the main agent has this: it runs helper agents in parallel, each on its own part of a page. */
export const DELEGATE_TOOL = {
  name: 'delegate',
  title: 'Delegate to helpers',
  description: 'Runs up to 4 helper agents at the same time, each on its own part of the document: a page and optionally a region of it. Helpers can read everything but only add and change things inside their own page/region. Use it for several independent pieces of work, e.g. solving four exercises in their own margins or answer areas. Regions on the same page must not overlap. Each task must be self-contained: say exactly what to do and where (the helper does not see this chat). Returns each helper\'s summary and the objects it created. Not for one small edit; do that yourself.',
  inputSchema: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        minItems: 1,
        maxItems: 4,
        items: {
          type: 'object',
          properties: {
            task: { type: 'string', minLength: 1, description: 'Complete instructions for this helper.' },
            page: { type: 'integer', minimum: 1 },
            region
          },
          required: ['task', 'page']
        }
      }
    },
    required: ['tasks']
  }
};

/** What helpers may call: reading anything, editing only on their own page and region (checked in the window). */
export const SUBAGENT_TOOLS = new Set([
  'get_document_info', 'get_page_text', 'search_text', 'render_page', 'list_objects', 'list_comments', 'list_form_fields', 'measure_text',
  'add_text', 'add_math', 'add_shape', 'add_line', 'add_image', 'draw', 'mark_text', 'add_comment', 'update_object', 'delete_object'
]);

const ALL_TOOLS = [...MCP_TOOLS, ...MEMORY_TOOLS, DELEGATE_TOOL];

/** @param {{ name: string; description: string; inputSchema: Record<string, unknown> }} tool */
const asFunction = (tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } });

/** The tools in the OpenAI function-calling format OpenRouter expects. */
export const AI_TOOLS = ALL_TOOLS.map(asFunction);
const SUBAGENT_FUNCTIONS = MCP_TOOLS.filter((tool) => SUBAGENT_TOOLS.has(tool.name)).map(asFunction);

/**
 * The website (any non-local visitor) runs tools in the visitor's own browser.
 * Tools that use a file path on this computer work on the visitor's files instead:
 * open/insert ask them to pick a PDF, save/extract download the file.
 */
const WEB_PATH_TOOLS = {
  open_document: 'Asks the person to pick a PDF from their computer and opens it in a new tab as the active document. Needs their approval (the pick happens on approval). path is ignored on the website.',
  insert_pdf: 'Asks the person to pick a PDF from their computer and inserts its pages after the given page (or at the end). Needs their approval. path is ignored on the website.',
  save_document: 'Downloads the active document with all edits to the person\'s computer. path is used as the file name only.',
  extract_pages: 'Downloads the chosen pages as a new PDF to the person\'s computer. path is used as the file name only.'
};
/** @param {any} tool */
function webTool(tool) {
  const description = WEB_PATH_TOOLS[/** @type {keyof typeof WEB_PATH_TOOLS} */ (tool.name)];
  if (!description) return tool;
  const schema = structuredClone(tool.inputSchema);
  if (Array.isArray(schema.required)) schema.required = schema.required.filter((/** @type {string} */ key) => key !== 'path');
  return { ...tool, description, inputSchema: schema };
}
/** Tools that write files or replace work need approval in the chat; on the website, picking a file does too. */
const WEB_APPROVAL_TOOLS = new Set([...AI_APPROVAL_TOOLS, 'open_document', 'insert_pdf']);
const WEB_TOOLS = [...MCP_TOOLS.map(webTool), ...MEMORY_TOOLS, DELEGATE_TOOL];
const WEB_FUNCTIONS = WEB_TOOLS.map(asFunction);
export const AI_WEB_TOOL_INFO = WEB_TOOLS.map((tool) => ({
  name: tool.name,
  title: tool.title,
  readOnly: Boolean(/** @type {any} */ (tool).annotations?.readOnlyHint),
  needsApproval: WEB_APPROVAL_TOOLS.has(tool.name)
}));

/** An OpenRouter key sent by a website visitor: used for that one request, never stored. @param {unknown} value */
export function visitorKey(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  return /^\S{20,300}$/.test(key) ? key : null;
}

/** Notes a website visitor keeps in their own browser, cleaned before they go into the prompt. @param {unknown} value */
export function visitorMemories(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && typeof entry.text === 'string')
    .slice(-30)
    .map((entry) => ({ text: String(entry.text).slice(0, 500), at: typeof entry.at === 'string' ? entry.at.slice(0, 40) : '' }));
}

/** What the chat window needs to show tool calls. */
export const AI_TOOL_INFO = ALL_TOOLS.map((tool) => ({
  name: tool.name,
  title: tool.title,
  readOnly: Boolean(/** @type {any} */ (tool).annotations?.readOnlyHint),
  needsApproval: AI_APPROVAL_TOOLS.has(tool.name)
}));

/** @returns {Promise<Record<string, { text: string; at: string }[]>>} */
async function readMemoryFile() {
  try {
    const data = JSON.parse(await readFile(MEMORY_FILE, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

/** @param {Record<string, { text: string; at: string }[]>} data */
async function writeMemoryFile(data) {
  await mkdir(join(homedir(), '.docuflex'), { recursive: true, mode: 0o700 });
  const temporary = `${MEMORY_FILE}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
  await rename(temporary, MEMORY_FILE);
}

/** Notes are kept per document name; "" holds notes made with no document open. @param {any} context */
function memoryKey(context) {
  return typeof context?.active?.name === 'string' ? context.active.name : '';
}

/** @param {any} context */
export async function documentMemories(context) {
  return (await readMemoryFile())[memoryKey(context)] ?? [];
}

/**
 * Runs remember / forget for the active document.
 * @param {string} name @param {Record<string, any>} args @param {any} context
 */
export async function runMemoryTool(name, args, context) {
  const key = memoryKey(context);
  const label = key || 'chats without a document';
  const data = await readMemoryFile();
  const notes = data[key] ?? [];
  if (name === 'remember') {
    const note = String(args.note ?? '').trim().slice(0, 500);
    if (!note) throw new Error('note is empty.');
    if (notes.some((entry) => entry.text === note)) return { saved: false, note: 'This note is already saved.', notes: notes.length };
    data[key] = [...notes, { text: note, at: new Date().toISOString() }].slice(-30);
    await writeMemoryFile(data);
    return { saved: true, document: label, notes: data[key].length };
  }
  if (args.all) {
    delete data[key];
    await writeMemoryFile(data);
    return { forgotten: notes.length, document: label };
  }
  const index = Number(args.number) - 1;
  if (!(index >= 0 && index < notes.length)) throw new Error(`There is no note ${args.number}. This document has ${notes.length} notes.`);
  data[key] = notes.filter((_, position) => position !== index);
  await writeMemoryFile(data);
  return { forgotten: 1, document: label, notes: data[key].length };
}

/**
 * @param {any} context what the window reports: open documents, current page, selection
 * @param {{ text: string; at: string }[]} [memories] saved notes about the active document
 */
export function systemPrompt(context, memories = []) {
  const now = new Date();
  return [
    'You are Docuflex AI, the assistant built into Docuflex, a PDF editor. You work like a careful agent: you read the document with tools, make changes with tools, check your work, and then answer briefly.',
    '',
    MCP_INSTRUCTIONS,
    '',
    'How to work:',
    '- Never guess what a document says. Read it (get_page_text, search_text) or look at it (render_page) first.',
    '- Attached images and render_page results are visible image inputs: inspect them directly. The PDF canvas is not continuously streamed to you. Before judging a drawing or placing something next to it, use render_page to inspect the relevant area; do not infer its appearance from chat text alone.',
    '- For "this page" or "here", use the current page from the context below. Selected pages and selected text in the context are what the person is pointing at.',
    '- Place added content relative to existing text: get its position from get_page_text or search_text. Check visual results with render_page.',
    '- Every edit can be undone by the person, so act without asking for ordinary edits. Saving files, extracting pages and closing documents ask the person for approval automatically; just call the tool.',
    '- Prefer few, precise tool calls. Batch independent calls in one turn.',
    '- If a tool fails, read the error, adjust and retry once; otherwise explain what went wrong.',
    '- Every edit result includes pageNow (what is on that page now). Trust it: the edit landed. NEVER repeat a call that succeeded. If unsure, call list_objects once.',
    '- Think briefly. Plan the few calls you need, then act.',
    '- For several independent parts (e.g. several exercises to solve, each in its own area), use delegate: one task per part with its page and a non-overlapping region. Read the pages first so you can give each helper exact positions. Afterwards check the result once with render_page.',
    '- Use remember for things worth knowing next time (preferences, decisions, what you did). Saved notes appear below.',
    '',
    'How to answer:',
    '- Be short and concrete. Say what you did, not how tools work. Use Markdown sparingly (short lists, **bold** for key facts).',
    '- Answer in the language the person writes in.',
    '- Write all math in LaTeX: \\( ... \\) inline and \\[ ... \\] on its own line for display formulas, e.g. \\( (g\\circ f)^{-1} = f^{-1}\\circ g^{-1} \\). The chat renders it in proper math type, so never write formulas as plain text or Unicode symbols. On pages, formulas go in add_math.',
    '- For summaries and questions about content, quote or cite page numbers.',
    '',
    `Today is ${now.toISOString().slice(0, 10)}.`,
    memories.length
      ? `Your saved notes about this document (forget deletes by number):\n${memories.map((entry, index) => `${index + 1}. ${entry.text}`).join('\n')}`
      : 'You have no saved notes about this document yet.',
    `Context from the Docuflex window: ${JSON.stringify(context ?? {})}`
  ].join('\n');
}

/**
 * Starts a streamed completion on OpenRouter.
 * @param {any[]} messages @param {any} context @param {AbortSignal} signal
 */
/**
 * Instructions for a helper agent working on one part of a page.
 * @param {{ page: number; region?: { x: number; y: number; width: number; height: number } | null }} scope @param {any} context
 */
export function subagentPrompt(scope, context) {
  const area = scope.region
    ? `the region x ${scope.region.x}–${scope.region.x + scope.region.width}, y ${scope.region.y}–${scope.region.y + scope.region.height} (points from the top-left) on page ${scope.page}`
    : `page ${scope.page}`;
  return [
    'You are a helper agent in Docuflex, a PDF editor. Another agent gave you one task. Other helpers work on other parts of the document at the same time.',
    '',
    MCP_INSTRUCTIONS,
    '',
    `Your area: ${area}. You may read anything, but only add things inside your area, and only change or delete objects you created. Calls outside your area are refused.`,
    'Work quickly: read what you need, make the edits, check once with render_page using a region around your area, fix problems, then stop.',
    'Never repeat a call that succeeded; every edit returns pageNow to confirm it.',
    'Finish with a short plain summary (1 to 3 sentences): what you placed, where, and the object ids. Mention anything you could not do.',
    `Document: ${JSON.stringify(context?.active ?? {})}`
  ].join('\n');
}

/**
 * @param {any[]} messages @param {any} context @param {AbortSignal} signal
 * @param {{ page: number; region?: any } | null} [subagent] a helper's scope; helpers get fewer tools and their own prompt
 * @param {string} [model] one of AI_MODELS; anything else uses AI_MODEL
 * @param {{ key: string; memories: { text: string; at: string }[] } | null} [web] a website visitor's own key and browser-kept notes
 */
export async function streamCompletion(messages, context, signal, subagent = null, model = AI_MODEL, web = null) {
  if (model === QWEN_MODEL_ID) {
    if (web) throw new Error('Local Qwen is only available in the macOS app.');
    const memories = await documentMemories(context);
    const system = subagent ? subagentPrompt(subagent, context) : systemPrompt(context, memories);
    return qwenChat([{ role: 'system', content: system }, ...messages], subagent ? SUBAGENT_FUNCTIONS : AI_TOOLS, signal);
  }
  const chosen = AI_MODELS.some((candidate) => candidate.id === model) ? model : AI_MODEL;
  const key = web ? web.key : await openRouterKey();
  if (!key) throw new Error(web ? 'Add your OpenRouter API key in Settings.' : 'No OpenRouter key is configured on this computer.');
  const memories = web ? web.memories : await documentMemories(context);
  const system = subagent ? subagentPrompt(subagent, context) : systemPrompt(context, memories);
  return fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://docuflex.eu',
      'X-Title': 'Docuflex'
    },
    body: JSON.stringify({
      ...modelRouting(chosen),
      stream: true,
      messages: [{ role: 'system', content: system }, ...messages],
      tools: subagent ? SUBAGENT_FUNCTIONS : web ? WEB_FUNCTIONS : AI_TOOLS,
      tool_choice: 'auto',
      parallel_tool_calls: true,
      reasoning: { max_tokens: REASONING_TOKENS },
      usage: { include: true }
    })
  });
}
