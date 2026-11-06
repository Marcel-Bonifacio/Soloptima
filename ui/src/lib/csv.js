// CSV text helpers shared by the script console and the import dialog (the same rules as the engine's import, engine/src/series)

// Delimiter of a CSV line (parseCSV).
const csvDelim = (line) => ((line.match(/;/g) || []).length > (line.match(/,/g) || []).length ? ';' : (line.includes('\t') ? '\t' : ','));

// Delimiter of a CSV file from its first non-blank lines: of ';', tab and ',', the one that splits most of them evenly (the same
// count on the most lines; ties in that order), so a title or metadata line above the data does not decide it.
export function csvDelimOf(lines) {
  let best = ',', top = 0;
  for (const d of [';', '\t', ',']) {
    const n = new Map();
    for (const l of lines) { const c = l.split(d).length - 1; if (c) n.set(c, (n.get(c) || 0) + 1); }
    for (const k of n.values()) if (k > top) { top = k; best = d; }
  }
  return best;
}

// One CSV line as trimmed cells: quoted fields may contain the delimiter; "" is a literal quote.
export function csvSplit(l, delim) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < l.length; i++) {
    const ch = l[i];
    if (q) {
      if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

// CSV text as { header: [...] | null, rows: [[...]] } (cells stay text).
export function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) return { header: null, rows: [] };
  const delim = csvDelim(lines[0]), split = (l) => csvSplit(l, delim);
  let header = null, start = 0;
  const first = split(lines[0]);
  if (first.some((c) => c !== '' && isNaN(Number(c)) && !/^\d{1,4}[-/:]/.test(c))) { header = first.map((c) => c.toLowerCase()); start = 1; }
  const rows = [];
  for (let i = start; i < lines.length; i++) rows.push(split(lines[i]));
  return { header, rows };
}
