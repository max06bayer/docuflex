/** Offered only after the model has a complete current source to edit. */
export const LATEX_REPAIR_RULES = [
  'Fix every compiler error while preserving the design and content. Redefined commands, missing packages, undefined commands and unbalanced braces are localized repairs, not reasons to rewrite the document.',
  'Use small targeted patches by default. Do not repeat the whole document or large unaffected sections. Return only pairs of fenced search and replace blocks. Each search must be an exact, nonempty excerpt that occurs ONCE in the current source. Include surrounding lines to disambiguate. Replacement blocks contain the corrected excerpt, or may be empty to delete it. Preserve literal TeX backslashes; do not JSON-escape them.',
  'For a command or environment that is already defined, remove the conflicting redefinition, use the existing environment, or rename the definition and its uses consistently. Changing numbering options such as [section] does not resolve a name collision.',
  'Example format:\n```search\nexact excerpt from the current source\n```\n```replace\ncorrected excerpt\n```',
  'You may return several pairs. All searches refer to the same current source, must not overlap, and are applied together. Do not include commentary.',
  'If the document truly needs a structural rewrite that cannot be fixed with small patches, respond only REWRITE_REQUIRED: followed by a short reason. Wait for explicit authorization in the next request before returning a complete document.'
].join('\n\n');

/**
 * Applies an atomic batch against the original source, never against earlier replacements.
 * Returns null for a normal full-document reply. Invalid patches leave the source untouched.
 * @param {string} source @param {string} reply
 * @returns {{tex: string; patches: number} | null}
 */
export function applyLatexPatches(source, reply) {
  if (!/```(?:search|replace)\b/.test(reply)) return null;
  if (!source) throw new Error('There is no current TeX source to patch. Return a complete document.');
  const blocks = /```(search|replace)[ \t]*\r?\n([\s\S]*?)```/g;
  const matches = [...reply.matchAll(blocks)];
  if (reply.replace(blocks, '').trim() || !matches.length || matches.length % 2 || matches.length > 64) {
    throw new Error('Return only complete search/replace pairs (at most 32), or one complete LaTeX document.');
  }
  /** @type {{start: number; end: number; replacement: string}[]} */
  const edits = [];
  for (let index = 0; index < matches.length; index += 2) {
    if (matches[index][1] !== 'search' || matches[index + 1][1] !== 'replace') throw new Error('Each search block must be followed by its replace block.');
    const search = matches[index][2].replace(/\r?\n$/, '');
    const replacement = matches[index + 1][2].replace(/\r?\n$/, '');
    if (!search) throw new Error('A search excerpt must not be empty.');
    const start = source.indexOf(search);
    if (start < 0) throw new Error(`Search excerpt not found: ${search.slice(0, 160)}. Copy it exactly from the current source.`);
    if (source.indexOf(search, start + 1) >= 0) throw new Error(`Search excerpt is ambiguous: ${search.slice(0, 160)}. Include more surrounding lines.`);
    const end = start + search.length;
    if (edits.some(edit => start < edit.end && end > edit.start)) throw new Error('Search excerpts overlap. Return disjoint replacements against the current source.');
    edits.push({start,end,replacement});
  }
  let tex = source;
  for (const edit of edits.sort((a,b) => b.start - a.start)) tex = tex.slice(0,edit.start) + edit.replacement + tex.slice(edit.end);
  if (tex === source) throw new Error('The replacements did not change the source. Fix the reported compiler error.');
  if (!tex.includes('\\documentclass') || !tex.includes('\\begin{document}') || !tex.includes('\\end{document}')) throw new Error('The patch removed required document structure. Return a valid complete document or preserve its document boundaries.');
  return {tex,patches:edits.length};
}
