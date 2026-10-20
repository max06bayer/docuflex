/**
 * Minimal Markdown for AI chat replies: paragraphs, headings, lists, quotes,
 * tables, code, bold/italic/strike, links and LaTeX math. Everything is escaped
 * first, so model output can never inject HTML.
 */

import { renderMathMarkup } from '$lib/math-render.js';

/** Rendered SVG per formula: a string when done, null when the LaTeX is invalid, undefined while rendering. */
/** @type {Map<string, string | null | undefined>} */
const mathCache = new Map();
/** @type {Set<() => void>} */
const mathListeners = new Set();

/** Calls back whenever a formula finishes rendering, so the chat can redraw. @param {() => void} listener */
export function onMathRendered(listener) {
  mathListeners.add(listener);
  return () => { mathListeners.delete(listener); };
}

/**
 * $$…$$ and \[…\] are display math; \(…\) and $…$ are inline. A single $ only
 * counts when it hugs its content ("$x^2$", not "costs $5 and $10").
 */
const MATH = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<![\\$\w])\$(?![\s$])((?:\\.|[^$\\\n])+?)(?<!\s)\$(?![\w$])/g;

/** Swaps math for \u0001n\u0001 markers, leaving code spans and fences untouched. @param {string} source */
function extractMath(source) {
  /** @type {{ tex: string; display: boolean }[]} */
  const math = [];
  const text = source.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/).map((part, index) => index % 2 ? part : part.replace(MATH, (_, block, bracket, paren, dollar) => {
    const display = block !== undefined || bracket !== undefined;
    math.push({ tex: String(block ?? bracket ?? paren ?? dollar).trim(), display });
    return `\u0001${math.length - 1}\u0001`;
  })).join('');
  return { text, math };
}

/** @param {{ tex: string; display: boolean }} formula */
function mathHtml({ tex, display }) {
  const key = `${display ? 'D' : 'I'}${tex}`;
  const className = display ? 'math display' : 'math';
  if (!mathCache.has(key) && typeof window !== 'undefined') {
    mathCache.set(key, undefined);
    void renderMathMarkup(tex, display).then((svg) => {
      mathCache.set(key, svg);
      for (const listener of mathListeners) listener();
    });
  }
  const svg = mathCache.get(key);
  if (svg) return `<span class="${className}">${svg}</span>`;
  // Shown while rendering, or as code when the LaTeX is invalid.
  return `<span class="${className} ${svg === null ? 'invalid' : 'pending'}"><code>${escapeHtml(tex)}</code></span>`;
}

/** @param {string} text */
function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** @param {string} text already escaped */
function inline(text) {
  /** @type {string[]} */
  const codes = [];
  let html = text.replace(/`([^`\n]+)`/g, (_, code) => {
    codes.push(`<code>${code}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  html = html
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return html.replace(/\u0000(\d+)\u0000/g, (_, index) => codes[Number(index)]);
}

/** Splits `| a | b |` into its cells. @param {string} line */
function tableCells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

/** A separator row such as `|---|:--:|`. @param {string} line */
function isTableSeparator(line) {
  return line.includes('-') && line.includes('|') && /^[\s|:-]+$/.test(line);
}

/**
 * @param {string} source
 * @param {number} [_mathVersion] changes when formulas finish rendering, so callers re-run this
 */
export function renderMarkdown(source, _mathVersion) {
  const { text, math } = extractMath(source.replace(/\r\n?/g, '\n'));
  const lines = escapeHtml(text).split('\n');
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  let paragraph = [];
  /** @type {{ type: 'ul' | 'ol'; items: string[] } | null} */
  let list = null;

  const flushParagraph = () => {
    if (paragraph.length) out.push(`<p>${inline(paragraph.join('\n')).replace(/\n/g, '<br>')}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.type}>${list.items.map((item) => `<li>${inline(item)}</li>`).join('')}</${list.type}>`);
    list = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = line.match(/^\s*```(\w*)/);
    if (fence) {
      flushParagraph();
      flushList();
      const code = [];
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index])) code.push(lines[index++]);
      out.push(`<pre><code>${code.join('\n')}</code></pre>`);
      continue;
    }
    if (line.includes('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      flushParagraph();
      flushList();
      const header = tableCells(line);
      const align = tableCells(lines[index + 1]).map((cell) => (cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : ''));
      /** @param {string} cell @param {number} column @param {'th' | 'td'} tag */
      const cellHtml = (cell, column, tag) => `<${tag}${align[column] ? ` style="text-align:${align[column]}"` : ''}>${inline(cell)}</${tag}>`;
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        const cells = tableCells(lines[index]);
        rows.push(`<tr>${header.map((_, column) => cellHtml(cells[column] ?? '', column, 'td')).join('')}</tr>`);
        index += 1;
      }
      index -= 1;
      out.push(`<div class="table-wrap"><table><thead><tr>${header.map((cell, column) => cellHtml(cell, column, 'th')).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`);
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      flushList();
      out.push(`<h${Math.min(heading[1].length + 2, 6)}>${inline(heading[2])}</h${Math.min(heading[1].length + 2, 6)}>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushParagraph();
      const type = bullet ? 'ul' : 'ol';
      if (list && list.type !== type) flushList();
      list ??= { type, items: [] };
      list.items.push((bullet ?? numbered)?.[1] ?? '');
      continue;
    }
    const quote = line.match(/^&gt;\s?(.*)$/);
    if (quote) {
      flushParagraph();
      flushList();
      out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      continue;
    }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      flushParagraph();
      flushList();
      out.push('<hr>');
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return out.join('').replace(/\u0001(\d+)\u0001/g, (_, index) => math[Number(index)] ? mathHtml(math[Number(index)]) : '');
}
