// Shared markdown-to-HTML renderer for vault documents.
//
// Used by DesignBench (SpecReader), ResearchShelf (DocReader), and
// FocusMode (spec content area). Handles headings, lists (ordered &
// unordered with checkboxes), tables, code blocks, blockquotes, HR,
// bold, italic, inline code, wikilinks, and markdown links.

export function renderMarkdown(md: string): string {
  const lines = md.split('\n');
  const html: string[] = [];
  let inCode = false;
  let inList = false;
  let listType: 'ul' | 'ol' = 'ul';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.trimStart().startsWith('```')) {
      if (inCode) { html.push('</code></pre>'); inCode = false; }
      else { if (inList) { html.push(listType === 'ul' ? '</ul>' : '</ol>'); inList = false; } html.push('<pre class="my-2 p-3 rounded-md bg-inset text-[11px] overflow-x-auto"><code>'); inCode = true; }
      continue;
    }
    if (inCode) { html.push(escapeHtml(line) + '\n'); continue; }

    if (inList && !/^\s*[-*+]\s|^\s*\d+\.\s/.test(line) && line.trim() !== '') {
      html.push(listType === 'ul' ? '</ul>' : '</ol>'); inList = false;
    }
    if (line.trim() === '') { if (inList) { html.push(listType === 'ul' ? '</ul>' : '</ol>'); inList = false; } continue; }
    if (/^---+$/.test(line.trim())) { html.push('<hr class="my-3 border-edge" />'); continue; }

    const hMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (hMatch) {
      const level = hMatch[1].length;
      const sizes = ['', 'text-[16px] font-semibold mt-5 mb-2', 'text-[14px] font-semibold mt-4 mb-1.5', 'text-[13px] font-medium mt-3 mb-1', 'text-[12px] font-medium mt-2 mb-1', 'text-[11px] font-medium mt-2 mb-1', 'text-[11px] font-medium mt-2 mb-1'];
      html.push(`<h${level} class="${sizes[level]} text-ink">${inlineFormat(hMatch[2])}</h${level}>`);
      continue;
    }

    if (line.startsWith('>')) {
      html.push(`<blockquote class="pl-3 border-l-2 border-edge text-ink-soft text-[11px] my-1 italic">${inlineFormat(line.replace(/^>\s?/, ''))}</blockquote>`);
      continue;
    }

    const ulMatch = line.match(/^(\s*)[-*+]\s+(.+)/);
    if (ulMatch) {
      if (!inList || listType !== 'ul') { if (inList) html.push('</ol>'); html.push('<ul class="list-disc pl-5 my-1 space-y-0.5 text-[11px] text-ink-soft">'); inList = true; listType = 'ul'; }
      const checked = ulMatch[2].startsWith('[x]') || ulMatch[2].startsWith('[X]');
      const unchecked = ulMatch[2].startsWith('[ ]');
      let text = ulMatch[2];
      if (checked || unchecked) text = text.slice(4);
      const prefix = checked ? '<span class="text-sage-text">&#10003;</span> ' : unchecked ? '<span class="text-ink-ghost">&#9744;</span> ' : '';
      html.push(`<li>${prefix}${inlineFormat(text)}</li>`);
      continue;
    }

    const olMatch = line.match(/^(\s*)\d+\.\s+(.+)/);
    if (olMatch) {
      if (!inList || listType !== 'ol') { if (inList) html.push('</ul>'); html.push('<ol class="list-decimal pl-5 my-1 space-y-0.5 text-[11px] text-ink-soft">'); inList = true; listType = 'ol'; }
      html.push(`<li>${inlineFormat(olMatch[2])}</li>`);
      continue;
    }

    // Table
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      if (inList) { html.push(listType === 'ul' ? '</ul>' : '</ol>'); inList = false; }
      const tableLines: string[] = [line];
      while (i + 1 < lines.length) {
        const next = lines[i + 1].trim();
        if (next.startsWith('|') && next.endsWith('|')) { tableLines.push(lines[i + 1]); i++; } else break;
      }
      html.push(renderTable(tableLines));
      continue;
    }

    html.push(`<p class="text-[11px] text-ink-soft leading-relaxed my-1">${inlineFormat(line)}</p>`);
  }
  if (inList) html.push(listType === 'ul' ? '</ul>' : '</ol>');
  if (inCode) html.push('</code></pre>');
  return html.join('\n');
}

function renderTable(tableLines: string[]): string {
  if (tableLines.length < 2) return tableLines.map((l) => `<p class="text-[11px] text-ink-soft my-1">${inlineFormat(l)}</p>`).join('\n');
  const parseCells = (row: string) => row.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const isSep = (row: string) => /^\|[\s:?-|]+\|$/.test(row.trim());
  const headerCells = parseCells(tableLines[0]);
  const hasSep = isSep(tableLines[1]);
  const dataStart = hasSep ? 2 : 1;
  const out: string[] = ['<div class="my-3 overflow-x-auto">', '<table class="w-full text-[11px] border-collapse">'];
  if (hasSep) {
    out.push('<thead><tr class="border-b border-edge">');
    for (const c of headerCells) out.push(`<th class="text-left text-ink font-medium px-2 py-1.5 text-[10px] uppercase tracking-wider">${inlineFormat(c)}</th>`);
    out.push('</tr></thead>');
  }
  out.push('<tbody>');
  for (let r = 0, ri = dataStart; ri < tableLines.length; ri++, r++) {
    if (isSep(tableLines[ri])) continue;
    const cells = parseCells(tableLines[ri]);
    out.push(`<tr class="border-b border-edge-subtle ${r % 2 === 1 ? 'bg-inset/40' : ''}">`);
    for (const c of cells) out.push(`<td class="px-2 py-1.5 text-ink-soft">${inlineFormat(c)}</td>`);
    out.push('</tr>');
  }
  out.push('</tbody></table></div>');
  return out.join('\n');
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function inlineFormat(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong class="font-semibold text-ink">$1</strong>');
  out = out.replace(/`([^`]+)`/g, '<code class="font-mono text-[0.92em] px-1 py-[1px] rounded bg-inset">$1</code>');
  out = out.replace(/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g, (_, target: string, alias: string) => {
    const display = alias || target.split('/').pop() || target;
    const vpath = target.endsWith('.md') ? target : `${target}.md`;
    return `<a href="#" data-vault-link="${escapeHtml(vpath)}" class="text-ink underline decoration-dotted decoration-ink-ghost/60 underline-offset-2 hover:text-sage-text hover:decoration-sage-text cursor-pointer transition-colors">${escapeHtml(display)}</a>`;
  });
  out = out.replace(/\[([^\]]+)\]\([^)]+\)/g, '<span class="text-ink underline decoration-dotted underline-offset-2">$1</span>');
  out = out.replace(/\*(.+?)\*/g, '<em>$1</em>');
  return out;
}
