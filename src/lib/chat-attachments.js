/** Chat documents are read locally; only their extracted text joins the model request. */
export const MAX_CHAT_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_CHAT_TEXT = 60000;
const OFFICE = new Set(['doc', 'docx', 'xlsx', 'pptx']);
const TEXT = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'html', 'htm', 'css', 'js', 'mjs', 'ts', 'py', 'rs', 'java', 'c', 'cpp', 'h', 'sh', 'yaml', 'yml', 'toml', 'log', 'tex', 'svelte', 'svg']);

/** @param {File} file @param {boolean} desktop */
export async function readChatDocument(file, desktop) {
  if (!file.size) throw new Error('This file is empty.');
  if (file.size > MAX_CHAT_FILE_BYTES) throw new Error('Files must be 20 MB or smaller.');
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  let source = file;
  if (OFFICE.has(extension)) {
    if (!desktop) throw new Error('Office attachments are available in the desktop app.');
    const form = new FormData();
    form.append('file', file);
    form.append('outputFormat', 'pdf');
    const response = await fetch('/api/convert', { method: 'POST', body: form });
    if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || 'Could not read this document.');
    source = new File([await response.blob()], `${file.name}.pdf`, { type: 'application/pdf' });
  }
  let text = '';
  if (source.type === 'application/pdf' || source.name.toLowerCase().endsWith('.pdf')) {
    const [pdfjs, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.mjs?url')]);
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    const task = pdfjs.getDocument({ data: await source.arrayBuffer() });
    // Do not leave encrypted attachments waiting on an invisible password prompt.
    task.onPassword = () => { void task.destroy(); };
    try {
      const document = await task.promise;
      for (let number = 1; number <= document.numPages && text.length <= MAX_CHAT_TEXT; number += 1) {
        const content = await (await document.getPage(number)).getTextContent();
        text += `\n[Page ${number}]\n` + content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('');
      }
    } finally {
      await task.destroy();
    }
  } else if (source.type.startsWith('text/') || TEXT.has(extension)) {
    text = await source.text();
  } else {
    throw new Error('Use a PDF, image, text file, DOC/DOCX, XLSX or PPTX document.');
  }
  if (!text.trim()) throw new Error('No readable text found. For scanned pages, attach an image or use OCR first.');
  if (text.includes('\0')) throw new Error('This file contains binary data and cannot be read as text.');
  const truncated = text.length > MAX_CHAT_TEXT;
  return { name: file.name, text: text.slice(0, MAX_CHAT_TEXT) + (truncated ? '\n[Attachment truncated at 60,000 characters.]' : '') };
}

/** @param {{name: string; text: string}[]} files */
export function chatDocumentPrompt(files) {
  return files.map(file => `Attached file: ${JSON.stringify(file.name)}\n<attachment>\n${file.text}\n</attachment>`).join('\n\n');
}
