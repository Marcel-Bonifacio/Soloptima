// A file name that every system accepts: characters that are invalid in names (\ / : * ? " < > | and control characters) become a
// space, runs of spaces collapse, and spaces and dots at the ends go. Applied once, in saveFile, for every export.
export function safeFileName(name, fallback = 'file') {
  const s = String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  return s || fallback;
}
