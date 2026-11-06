// Minimal Markdown for the bundled legal texts and release notes, parsed into blocks of inline tokens that Markdown.svelte
// renders with Svelte's own escaping (no HTML string is ever built). Headings, paragraphs, lists (indented lines continue
// an item), block quotes, tables, fenced code, inline code, bold, http(s) links and #anchor jumps.
const INLINE = /`([^`]+)`|\*\*\*([^*]+)\*\*\*|\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|\[([^\]]+)\]\(#([\w-]+)\)|<(https?:\/\/\S+?)>/g;

// [{t: 'text' | 'code' | 'bi' | 'b' | 'link' | 'jump', text, href}]
export function inline(s) {
  const out = [];
  let last = 0;
  for (const m of s.matchAll(INLINE)) {
    if (m.index > last) out.push({ t: 'text', text: s.slice(last, m.index) });
    const [, code, bi, b, lt, lu, jt, ja, au] = m;
    if (code != null) out.push({ t: 'code', text: code });
    else if (bi != null) out.push({ t: 'bi', text: bi });
    else if (b != null) out.push({ t: 'b', text: b });
    else if (lt != null) out.push({ t: 'link', text: lt, href: lu });
    else if (jt != null) out.push({ t: 'jump', text: jt, href: ja });
    else out.push({ t: 'link', text: au, href: au });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ t: 'text', text: s.slice(last) });
  return out;
}

const slug = (s) => s.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');

// [{t: 'p' | 'h' | 'code' | 'table' | 'list' | 'quote', ...}]
export function parse(md) {
  const lines = String(md || '').replace(/\r/g, '').split('\n'), out = [];
  const LIST = /^\s*([-*]|\d+\.)\s/;
  let para = [];
  const flush = () => { if (para.length) out.push({ t: 'p', inl: inline(para.join(' ')) }); para = []; };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^```/.test(l)) {
      flush();
      const code = [];
      while (++i < lines.length && !/^```/.test(lines[i])) code.push(lines[i]);
      out.push({ t: 'code', text: code.join('\n') });
    } else if (/^#{1,4}\s/.test(l)) {
      flush();
      const n = l.match(/^#+/)[0].length, text = l.slice(n).trim();
      out.push({ t: 'h', level: n + 1, id: 'md-' + slug(text), inl: inline(text) });
    } else if (/^\|/.test(l) && /^\|?\s*:?-{3,}/.test(lines[i + 1] || '')) {
      flush();
      const cells = (s) => s.replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
      const head = cells(l), rows = [];
      i++;
      while (i + 1 < lines.length && /^\|/.test(lines[i + 1])) rows.push(cells(lines[++i]));
      out.push({ t: 'table', head, rows });
    } else if (LIST.test(l)) {
      flush();
      const ordered = /^\s*\d+\./.test(l), items = [];
      for (; i < lines.length; i++) {
        if (LIST.test(lines[i])) items.push([lines[i].replace(/^\s*([-*]|\d+\.)\s+/, '')]);
        else if (/^ {2,}\S/.test(lines[i])) items[items.length - 1].push(lines[i].trim());
        else break;
      }
      i--;
      out.push({ t: 'list', ordered, items: items.map((it) => it.map(inline)) });
    } else if (/^>\s?/.test(l)) {
      flush();
      const q = [];
      for (; i < lines.length && /^>\s?/.test(lines[i]); i++) q.push(lines[i].replace(/^>\s?/, '').trim());
      i--;
      out.push({ t: 'quote', inl: inline(q.join(' ')) });
    } else if (!l.trim()) flush();
    else para.push(l.trim());
  }
  flush();
  return out;
}
