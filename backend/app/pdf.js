'use strict';
/**
 * Minimal PDF writer (no dependencies): A4 pages of Helvetica text with automatic line wrapping and page
 * breaks. Text is written with WinAnsiEncoding, so Spanish accents and the characters used in the reports
 * (ñ, ¿, ¡, ×, °) display correctly and can be extracted with `pdftotext`.
 *
 * A line is a string or `{text, bold?, size?, gap?}`; `gap` adds blank space before the line (points).
 */
const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 50;
const TOP = PAGE_HEIGHT - MARGIN;
const BOTTOM = MARGIN;
/** Average Helvetica glyph width as a fraction of the font size (conservative, so lines never overflow). */
const GLYPH_WIDTH = 0.52;

const REPLACEMENTS = Object.freeze({ '–': '-', '—': '-', '“': '"', '”': '"', '‘': "'", '’': "'", '•': '*', '…': '...', '₂': '2', ' ': ' ' });

/** Escaped PDF string body: latin1 characters only, with the PDF delimiters escaped. */
function encode(text) {
  let out = '';
  for (const ch of String(text)) {
    const mapped = REPLACEMENTS[ch] ?? ch;
    const code = mapped.codePointAt(0);
    if (code > 255) out += '?';
    else if (mapped === '\\' || mapped === '(' || mapped === ')') out += `\\${mapped}`;
    else out += mapped;
  }
  return out;
}

function wrap(text, size, width = PAGE_WIDTH - 2 * MARGIN) {
  const limit = Math.max(20, Math.floor(width / (size * GLYPH_WIDTH)));
  const words = String(text).split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line && line.length + 1 + word.length > limit) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  lines.push(line);
  return lines;
}

/**
 * @param {{title: string, lines: Array<string|{text: string, bold?: boolean, size?: number, gap?: number}>}} input
 * @returns {Buffer}
 */
function buildPdf({ title, lines }) {
  const pages = [[]];
  let y = TOP;
  for (const raw of lines) {
    const item = typeof raw === 'string' ? { text: raw } : raw;
    const size = item.size || 10;
    const leading = size * 1.4;
    const wrapped = wrap(item.text, size);
    const needed = (item.gap || 0) + leading * wrapped.length;
    if (y - needed < BOTTOM && pages[pages.length - 1].length) { pages.push([]); y = TOP; }
    y -= item.gap || 0;
    for (const text of wrapped) {
      y -= leading;
      pages[pages.length - 1].push({ text, size, bold: Boolean(item.bold), y });
    }
  }

  // Objects: 1 catalog, 2 pages, 3 regular font, 4 bold font, 5 info, then (content, page) per page.
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('PAGES');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  add(`<< /Title (${encode(title)}) /Producer (Vatio Local) >>`);
  const kids = [];
  for (const page of pages) {
    const stream = page.map((l) => `BT /${l.bold ? 'F2' : 'F1'} ${l.size} Tf ${MARGIN} ${l.y.toFixed(1)} Td (${encode(l.text)}) Tj ET`).join('\n');
    const contentId = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    const pageId = add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`);
    kids.push(`${pageId} 0 R`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`;

  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

module.exports = { buildPdf };
