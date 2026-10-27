import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as env from '$app/env/private';
import { AI_FALLBACK_MODEL, AI_MODEL, AI_MODELS, openRouterKey } from '#lib/server/ai.js';

/**
 * PDF to LaTeX: a model rewrites a PDF or scan as a complete LaTeX document,
 * Tectonic compiles it, and compile errors go back to the model until the
 * document builds. Tectonic is bundled with the desktop app; it fetches the
 * TeX packages a document needs once and keeps them in its cache.
 */

const COMPILE_TIMEOUT = 240_000;
const MAX_ATTEMPTS = 4;
/** Compare-and-fix rounds when a translation should match the original's look. */
const REVIEW_ROUNDS = 2;
/** Pages compared per review round (original next to result). */
const REVIEW_PAGES = 8;
const MAX_OUTPUT_TOKENS = 32_000;
/** Page renders sent to the model; later pages go as text only. */
export const MAX_PAGE_IMAGES = 24;

/** Translation only: rebuild the original's own look instead of a new design. */
export const MATCH_STYLE = { id: 'match', label: 'Auto' };

/** How embedded font names map to LaTeX packages that look alike (all compile with Tectonic). */
const FONT_GUIDE = [
  'Font matching: pick LaTeX packages that look like the source fonts listed below (names come from the PDF; a prefix like ABCDEF+ is a subset tag).',
  '- Computer Modern (CMR, CMMI, CMSY, CMBX, SFRM, LMRoman) → lmodern (default math).',
  '- Times, Times New Roman, Nimbus Roman, TeX Gyre Termes → newtxtext + newtxmath.',
  '- Helvetica, Arial, Nimbus Sans, Liberation Sans → \\usepackage{tgheros} with \\renewcommand{\\familydefault}{\\sfdefault} (keep math with sansmath-like care, or newtxmath).',
  '- Palatino, Book Antiqua, URW Palladio → newpxtext + newpxmath.',
  '- Calibri → carlito; Cambria → caladea; Garamond, EB Garamond → ebgaramond; Charter → XCharter; Century Schoolbook → tgschola; Bookman → tgbonum; Avant Garde, Century Gothic → tgadventor; Courier → tgcursor.',
  '- Source Sans → sourcesanspro; Source Serif → sourceserifpro; Open Sans → opensans; Lato → lato; Fira Sans → FiraSans; Roboto → roboto; Libertine → libertinus; Noto Sans/Serif → noto; Merriweather → merriweather; Montserrat → montserrat; Raleway → raleway; IBM Plex → plex-sans / plex-serif; DejaVu → dejavu; Crimson → crimson; Baskerville → librebaskerville; Inconsolata, monospace code → inconsolata.',
  '- Unknown font: choose by look from the render (serif or sans, light or heavy, wide or narrow).',
  'Match the body font, the heading font (headings may use a different family, e.g. \\sffamily\\bfseries via titlesec) and the math font. Match the base size with the class option (10pt/11pt/12pt) and heading sizes with titlesec. Bold/italic in a font name (Bold, BoldItalic, -BI, Oblique) shows where the source uses them.'
].join('\n');

export const LATEX_STYLES = [
  { id: 'paper', label: 'Scientific Paper', prompt: 'A journal article: title block with authors/affiliation if known, an abstract box, numbered sections, two-column layout (\\documentclass[twocolumn]{article} or a balanced multicol body) unless content is too wide, compact serif typography (e.g. newtxtext/newtxmath or libertinus), captions in small caps label style, booktabs tables, a references section when the source has one.' },
  { id: 'report', label: 'Modern Report', prompt: 'A polished modern report: single column, generous margins, a striking title page or header band in a deep accent colour, sans-serif headings (e.g. \\usepackage[sfdefault]{roboto} for headings via titlesec, or sourcesanspro), coloured tcolorbox callouts for key findings, summary boxes, icons-free clean infographic-style TikZ/pgfplots charts, fancyhdr header and footer with page numbers.' },
  { id: 'notes', label: 'Lecture Notes', prompt: 'Textbook-style lecture notes: chapter-like section openers, numbered definition / theorem / example / remark environments in distinct tcolorbox styles (amsthm + tcolorbox), margin notes where useful, worked examples step by step, lots of explanatory diagrams in TikZ.' },
  { id: 'classic', label: 'Classic Academic', prompt: 'A restrained classic academic document in Computer Modern / Latin Modern: article class, single column, minimal colour (black with one dark-blue accent for links), precise typography with microtype, booktabs tables, numbered equations.' },
  { id: 'auto', label: 'Auto', prompt: 'Choose the style that fits the source best (paper, report, notes, letter, worksheet, CV, slides-like handout ...). Match the kind of document, but make it look like the most professional version of it.' }
];

const engineCandidates = () => [
  env.DOCUFLEX_TECTONIC,
  // The desktop app starts the server inside its resources folder.
  resolve('runtime/tectonic/tectonic'),
  resolve('runtime/tectonic/tectonic.exe'),
  // Local development uses the copy staged for the desktop build.
  resolve('desktop/src-tauri/resources/runtime/tectonic/tectonic'),
  ...(env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean).map((directory) => join(directory, process.platform === 'win32' ? 'tectonic.exe' : 'tectonic'))
].filter(Boolean);

/** @type {string | null | undefined} */
let enginePath;

export async function tectonicPath() {
  if (enginePath !== undefined && enginePath !== null) return enginePath;
  for (const candidate of engineCandidates()) {
    try {
      await access(/** @type {string} */ (candidate), constants.X_OK);
      return (enginePath = /** @type {string} */ (candidate));
    } catch {}
  }
  return (enginePath = null);
}

export function latexModels() {
  return { model: AI_MODEL, models: AI_MODELS };
}

/** Goals when translating: the source's look stays, only the language changes. @param {string} language */
function translateGoals(language) {
  return [
    `You are Docuflex LaTeX, an expert translator and typesetter. You translate a PDF or scanned document into ${language} and rebuild it as one complete, compilable LaTeX document that looks like the original.`,
    '',
    'Goals, in order:',
    `1. Complete, faithful translation into ${language}: every heading, paragraph, list item, table cell, caption, label inside figures, footnote and page header/footer. Use correct technical and mathematical terminology of ${language}. Never translate math, variable names, code, units or proper names; keep all numbers and formulas exactly. Fix obvious OCR or scan errors, but never add or drop content.`,
    '2. Keep the original design exactly: same paper size and orientation, similar margins, the same column layout, the same structure and numbering of sections and exercises, the same kind of fonts (serif or sans, sizes, bold/italic), the same colours, boxes, rules, tables and alignment, and roughly the same page breaks. Do NOT redesign, restyle or add decoration. It must look like the original document, just in the new language.',
    '3. Small layout adjustments are fine where translated text is longer or shorter (spacing, line breaks), so everything fits like in the original.',
    '4. Recreate charts and diagrams of the source with TikZ or pgfplots so their labels can be translated, matching the original look. Add no new visuals.',
    '5. Photos and complex raster images that cannot be redrawn: the page renders are available as files page-1.jpg, page-2.jpg, ... (sizes given below, 1 px = 1 bp). Crop the region with \\includegraphics[trim=LEFT BOTTOM RIGHT TOP, clip, width=...]{page-N.jpg} (trim values in bp measured from each edge). Never include a whole page render as a figure.'
  ];
}

/** @param {string} [translateTo] the target language when translating @param {boolean} [match] keep the original design */
function systemPrompt(translateTo = '', match = false) {
  return [
    ...(match ? translateGoals(translateTo) : [
    'You are Docuflex LaTeX, an expert typesetter and scientific designer. You turn a PDF or scanned document into one complete, compilable LaTeX document that looks like a top-tier professional publication.',
    '',
    'Goals, in order:',
    ...(translateTo ? [`0. Translate the complete document into ${translateTo}: every heading, paragraph, table cell, caption, figure label and footnote. Use correct technical terminology of ${translateTo}. Never translate math, variable names, code, units or proper names.`] : []),
    '1. Faithful content: keep every piece of information of the source (all text, numbers, formulas, tables, lists, figures, footnotes, references). Fix obvious OCR or scan errors and typos, but never invent facts, data, authors or citations.',
    '2. Exceptional design: format the hell out of it. Clear hierarchy, consistent spacing, a coherent colour palette defined once with \\definecolor, beautiful tables (booktabs, tabularx, \\rowcolors from xcolor[table]), highlighted key results in tcolorbox boxes, properly typeset math (amsmath, mathtools, siunitx for units), numbered and captioned figures and tables, a header/footer with page numbers.',
    '3. Visuals: recreate every chart, plot, diagram, flowchart, timeline and schematic of the source as vector graphics with TikZ or pgfplots (use the real data values you can read). Where it genuinely helps understanding, add a small extra visual (e.g. a bar chart of a data table or a process diagram of a described procedure), clearly based only on the source content.',
    '4. Photos and complex raster images that cannot be redrawn: the page renders are available as files page-1.jpg, page-2.jpg, ... (sizes given below, 1 px = 1 bp). Crop the region with \\includegraphics[trim=LEFT BOTTOM RIGHT TOP, clip, width=...]{page-N.jpg} (trim values in bp measured from each edge). Never include a whole page render as a figure.'
    ]),
    '',
    'Technical rules (the compiler is Tectonic with XeTeX and a TeX Live 2023 package set; it has no shell escape):',
    '- Output exactly one complete document from \\documentclass to \\end{document} inside a single ```latex code block, and nothing else after it.',
    '- Use only widely available packages: geometry, fontspec (optional), amsmath, amssymb, amsthm, mathtools, siunitx, xcolor, graphicx, booktabs, tabularx, array, multirow, makecell, longtable, colortbl, enumitem, microtype, caption, subcaption, float, hyperref, fancyhdr, titlesec, multicol, tcolorbox (with \\tcbuselibrary{skins,breakable,theorems}), tikz, pgfplots (\\pgfplotsset{compat=1.18}), pgfplotstable, lmodern, libertinus, newtx, sourcesanspro, roboto, babel or polyglossia, csquotes, listings, adjustbox, wrapfig. Never use lipsum or placeholder text.',
    '- Pick fonts only through font packages (lmodern, libertinus, newtxtext/newtxmath, sourcesanspro, roboto). Never \\setmainfont or \\fontspec a font by name: system fonts are not available.',
    '- No minted, no \\write18, no external files except page-N.jpg, no bibliography files (write references with thebibliography or a plain list).',
    translateTo ? `- Set up babel/polyglossia for ${translateTo}.` : '- Keep the document language of the source. Use babel/polyglossia accordingly.',
    '- Long tables must break across pages (longtable or tcolorbox breakable). Boxes holding long text must be breakable.',
    '- Make sure every figure fits the text width (\\linewidth) and every environment is closed. Escape special characters (% & $ # _ { } ~ ^ \\) in text.',
    '- Prefer robust constructs over fragile hacks. The document must compile on the first try.'
  ].join('\n');
}

/**
 * @param {{ text: string; image?: string | null; width?: number; height?: number }[]} pages
 * @param {string} styleId @param {string} instructions @param {string} name @param {string} [translateTo] @param {string[]} [fonts]
 */
function sourceMessage(pages, styleId, instructions, name, translateTo = '', fonts = []) {
  const style = LATEX_STYLES.find((entry) => entry.id === styleId) ?? LATEX_STYLES[LATEX_STYLES.length - 1];
  /** @type {any[]} */
  const content = [{
    type: 'text',
    text: [
      `Source file: ${name || 'document.pdf'}, ${pages.length} page${pages.length === 1 ? '' : 's'}.`,
      styleId === MATCH_STYLE.id
        ? `Translate into ${translateTo} and keep the original design.\n${FONT_GUIDE}\nFonts embedded in the source: ${fonts.length ? fonts.join(', ') : 'none found (scan) — judge from the renders'}.`
        : `${translateTo ? `Translate into ${translateTo}. ` : ''}Requested style: ${style.label}. ${style.prompt}`,
      instructions ? `Extra wishes from the person: ${instructions}` : '',
      'Each page follows: its extracted text layer (may be empty for scans or wrong for bad OCR — trust the image) and its render.'
    ].filter(Boolean).join('\n')
  }];
  pages.forEach((page, index) => {
    const size = page.width && page.height ? ` (page-${index + 1}.jpg, ${page.width}×${page.height} px)` : '';
    content.push({ type: 'text', text: `--- Page ${index + 1}${page.image ? size : ' (no render)'} ---\n${(page.text || '').slice(0, 12_000) || '[no text layer]'}` });
    if (page.image) content.push({ type: 'image_url', image_url: { url: page.image } });
  });
  content.push({ type: 'text', text: 'Now write the complete LaTeX document.' });
  return { role: 'user', content };
}

/** @param {string} reply */
export function extractLatex(reply) {
  const fenced = [...reply.matchAll(/```(?:latex|tex)?\s*\n([\s\S]*?)```/g)].map((match) => match[1]);
  const candidate = fenced.find((block) => block.includes('\\documentclass')) ?? fenced[0] ?? reply;
  const start = candidate.indexOf('\\documentclass');
  const end = candidate.lastIndexOf('\\end{document}');
  if (start < 0) return null;
  return end > start ? candidate.slice(start, end + '\\end{document}'.length) : `${candidate.slice(start)}\n\\end{document}`;
}

/**
 * One streamed completion; reports the length of the answer as it grows.
 * @param {{ key: string; model: string; messages: any[]; signal: AbortSignal; onProgress: (characters: number) => void }} options
 */
async function complete({ key, model, messages, signal, onProgress }) {
  const chosen = AI_MODELS.some((candidate) => candidate.id === model) ? model : AI_MODEL;
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://docuflex.eu',
      'X-Title': 'Docuflex'
    },
    body: JSON.stringify({
      models: chosen === AI_FALLBACK_MODEL ? [chosen] : [chosen, AI_FALLBACK_MODEL],
      stream: true,
      max_tokens: MAX_OUTPUT_TOKENS,
      reasoning: { max_tokens: 4096 },
      messages
    })
  });
  if (!response.ok || !response.body) {
    const details = await response.json().catch(() => null);
    const message = details?.error?.message || `The AI service answered with HTTP ${response.status}.`;
    throw new Error(response.status === 401 ? 'OpenRouter rejected the API key. Check it in Settings.' : message);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let lastReport = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const event = JSON.parse(data);
        if (event.error) throw new Error(event.error.message || 'The AI service failed.');
        const delta = event.choices?.[0]?.delta?.content;
        if (typeof delta === 'string') text += delta;
      } catch (failure) {
        if (failure instanceof Error && !(failure instanceof SyntaxError)) throw failure;
      }
    }
    if (text.length - lastReport > 400) {
      lastReport = text.length;
      onProgress(text.length);
    }
  }
  onProgress(text.length);
  return text;
}

/**
 * Compiles a document with Tectonic in a fresh folder holding the page renders.
 * @param {string} tex @param {{ name: string; bytes: Buffer }[]} files @param {AbortSignal} signal
 * @param {(line: string) => void} onLog
 */
export async function compileLatex(tex, files, signal, onLog = () => {}) {
  const engine = await tectonicPath();
  if (!engine) throw new Error('The LaTeX engine is not installed.');
  const folder = await mkdtemp(join(tmpdir(), 'docuflex-latex-'));
  try {
    await writeFile(join(folder, 'main.tex'), tex);
    await Promise.all(files.map((file) => writeFile(join(folder, file.name), file.bytes)));
    const log = await new Promise((resolvePromise, reject) => {
      const child = spawn(engine, ['-X', 'compile', '--untrusted', '--keep-logs', 'main.tex'], { cwd: folder, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      /** @param {Buffer} chunk */
      const collect = (chunk) => {
        const piece = chunk.toString();
        output += piece;
        for (const line of piece.split('\n')) if (line.trim()) onLog(line.trim());
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      const timer = setTimeout(() => child.kill('SIGKILL'), COMPILE_TIMEOUT);
      const abort = () => child.kill('SIGKILL');
      signal.addEventListener('abort', abort, { once: true });
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        resolvePromise({ code, output });
      });
    });
    const { code, output } = /** @type {{ code: number | null; output: string }} */ (log);
    if (code === 0) return { ok: true, pdf: await readFile(join(folder, 'main.pdf')), log: output };
    const texLog = await readFile(join(folder, 'main.log'), 'utf8').catch(() => '');
    return { ok: false, pdf: null, log: summarizeErrors(output, texLog) };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** The useful part of a failed compile: error lines with a little context. @param {string} output @param {string} texLog */
function summarizeErrors(output, texLog) {
  const lines = texLog.split('\n');
  const picked = [];
  for (let index = 0; index < lines.length && picked.length < 60; index += 1) {
    if (lines[index].startsWith('!') || /^l\.\d+/.test(lines[index])) picked.push(...lines.slice(Math.max(0, index - 1), index + 4));
  }
  const errors = output.split('\n').filter((line) => /error|undefined|not found|missing/i.test(line)).slice(0, 25);
  return [...errors, ...picked].join('\n').slice(0, 6000) || output.slice(-4000);
}

/**
 * Renders the first pages of a compiled PDF as small JPEGs for the review round.
 * Uses Poppler's pdftoppm, which the desktop app bundles for OCR.
 * @param {Buffer} pdf @param {number} pages @param {AbortSignal} signal
 */
async function renderPdf(pdf, pages, signal) {
  const folder = await mkdtemp(join(tmpdir(), 'docuflex-latex-render-'));
  try {
    await writeFile(join(folder, 'result.pdf'), pdf);
    await new Promise((resolvePromise, reject) => {
      const child = spawn(env.PDFTOPPM_BIN?.trim() || 'pdftoppm', ['-jpeg', '-jpegopt', 'quality=72', '-r', '90', '-l', String(pages), 'result.pdf', 'page'], { cwd: folder, stdio: 'ignore' });
      const abort = () => child.kill('SIGKILL');
      signal.addEventListener('abort', abort, { once: true });
      child.on('error', reject);
      child.on('close', (code) => {
        signal.removeEventListener('abort', abort);
        code === 0 ? resolvePromise(null) : reject(new Error(`pdftoppm exited with ${code}`));
      });
    });
    const names = (await readdir(folder)).filter((file) => file.endsWith('.jpg')).sort();
    return Promise.all(names.map(async (file) => `data:image/jpeg;base64,${(await readFile(join(folder, file))).toString('base64')}`));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** How many pages a PDF has, from its page tree (good enough for the review note). @param {Buffer} pdf */
function pageCount(pdf) {
  const counts = [...pdf.toString('latin1').matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)/g)].map((match) => Number(match[1]));
  return counts.length ? Math.max(...counts) : 0;
}

/**
 * The whole conversion. Reports stages through onEvent and returns the PDF and source.
 * @param {{ pages: { text: string; image?: string | null; width?: number; height?: number }[]; model: string; style: string; instructions: string; name: string; translateTo?: string; fonts?: string[]; key: string | null; signal: AbortSignal; onEvent: (event: Record<string, any>) => void }} options
 */
export async function convertToLatex({ pages, model, style, instructions, name, translateTo = '', fonts = [], key, signal, onEvent }) {
  const apiKey = key ?? (await openRouterKey());
  if (!apiKey) throw new Error('Add your OpenRouter API key in Settings.');
  const files = pages.flatMap((page, index) => {
    const match = page.image?.match(/^data:image\/jpeg;base64,(.+)$/);
    return match ? [{ name: `page-${index + 1}.jpg`, bytes: Buffer.from(match[1], 'base64') }] : [];
  });
  const match = Boolean(translateTo) && style === MATCH_STYLE.id;
  const source = sourceMessage(pages, style, instructions, name, translateTo, fonts);
  const system = { role: 'system', content: systemPrompt(translateTo, match) };

  /**
   * Gets a document from the model and compiles it, sending compile errors back until it builds.
   * @param {any[]} conversation @param {'writing' | 'refining'} stage @param {number} round
   */
  const build = async (conversation, stage, round = 0) => {
    const messages = [...conversation];
    let tex = '';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const writing = attempt === 1 ? stage : 'fixing';
      onEvent({ stage: writing, attempt, round, characters: 0 });
      const reply = await complete({ key: apiKey, model, messages, signal, onProgress: (characters) => onEvent({ stage: writing, attempt, round, characters }) });
      if (stage === 'refining' && attempt === 1 && /^\s*NO_CHANGES\s*$/.test(reply.replace(/```/g, ''))) return null;
      const extracted = extractLatex(reply);
      if (!extracted) {
        messages.push({ role: 'assistant', content: reply.slice(0, 4000) }, { role: 'user', content: 'That was not a LaTeX document. Answer with the complete document in one ```latex block.' });
        continue;
      }
      tex = extracted;
      onEvent({ stage: 'compiling', attempt, round });
      let fetching = false;
      const result = await compileLatex(tex, files, signal, (line) => {
        if (!fetching && /downloading/i.test(line)) {
          fetching = true;
          onEvent({ stage: 'packages', attempt, round });
        }
      });
      if (result.ok && result.pdf) return { pdf: result.pdf, tex, attempts: attempt };
      console.warn(`[latex] attempt ${attempt} did not compile:\n${result.log.slice(0, 1500)}`);
      onEvent({ stage: 'error', attempt, round, log: result.log.slice(0, 600) });
      // Only the latest source goes back, so retries stay small.
      messages.splice(conversation.length, messages.length - conversation.length,
        { role: 'assistant', content: `\`\`\`latex\n${tex}\n\`\`\`` },
        { role: 'user', content: `Compiling with Tectonic (XeTeX) failed:\n${result.log}\n\nFix every error (replace unavailable packages, close environments, escape characters) and answer with the complete corrected document in one \`\`\`latex block. Keep the design and content.` }
      );
    }
    if (stage === 'refining') return null;
    const failure = new Error('The LaTeX document did not compile after several attempts.');
    /** @type {any} */ (failure).tex = tex;
    throw failure;
  };

  let best = /** @type {{ pdf: Buffer; tex: string; attempts: number }} */ (await build([system, source], 'writing'));
  if (!match) return best;

  // Matching the original: show the model its result next to the source and let it fix what differs.
  for (let round = 1; round <= REVIEW_ROUNDS; round += 1) {
    onEvent({ stage: 'reviewing', round });
    let renders;
    try {
      renders = await renderPdf(best.pdf, REVIEW_PAGES, signal);
    } catch (failure) {
      console.warn('[latex] could not render the result for review:', failure);
      break;
    }
    const resultPages = pageCount(best.pdf);
    /** @type {any[]} */
    const content = [{
      type: 'text',
      text: [
        `Review round ${round}. Your document compiled to ${resultPages || renders.length} page${resultPages === 1 ? '' : 's'}; the source has ${pages.length}.`,
        'Below, each page of your result follows the matching page of the original. Compare them closely and fix every difference that is not the translation itself:',
        '- overlapping, clipped or cut-off text, text running into margins or into figures, overfull boxes;',
        '- wrong fonts (serif vs sans, weight, size, italic), wrong heading sizes, wrong line spacing;',
        '- positions, alignment, indentation, column layout, table and box styling, colours, rules;',
        '- page breaks drifting from the original (shrink spacing or font size slightly rather than spilling onto extra pages);',
        '- anything missing, duplicated or left untranslated.',
        'Answer with the complete corrected document in one ```latex block. Only if the result already matches the original closely, answer exactly NO_CHANGES.'
      ].join('\n')
    }];
    renders.forEach((image, index) => {
      const original = pages[index]?.image;
      if (original) content.push({ type: 'text', text: `Original page ${index + 1}:` }, { type: 'image_url', image_url: { url: original } });
      content.push({ type: 'text', text: `Your page ${index + 1}:` }, { type: 'image_url', image_url: { url: image } });
    });
    const conversation = [system, source, { role: 'assistant', content: `\`\`\`latex\n${best.tex}\n\`\`\`` }, { role: 'user', content }];
    const refined = await build(conversation, 'refining', round);
    if (!refined) break;
    best = { ...refined, attempts: best.attempts + refined.attempts };
  }
  return best;
}
