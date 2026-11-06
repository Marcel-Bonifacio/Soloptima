// The figures a user adds to the report (P.report): what a saved or imported project may hold, and the scaling of a new image.
export const FIG_PLACES = { site: 'Site and solar resource', pv: 'PV system and energy yield', electrical: 'Electrical design', simulation: 'Energy simulation', appendix: 'Additional figures' };
export const DATA_IMG = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;
export const MAX_FIGURES = 12;
const randomId = (taken) => { let id; do id = Math.random().toString(36).slice(2, 10); while (taken(id)); return id; };

// P.report as the app expects it, also for an imported file: a plain object, a boolean imagery, and figures that are valid images
// with a caption, a known place and a unique id
export function cleanReport(p) {
  const r = p.report;
  if (!r || typeof r !== 'object' || Array.isArray(r)) { p.report = { imagery: true, figures: [] }; return; }
  r.imagery = !!r.imagery;
  const ids = new Set();
  r.figures = (Array.isArray(r.figures) ? r.figures : []).filter((f) => f && typeof f === 'object' && typeof f.src === 'string' && DATA_IMG.test(f.src)).map((f) => {
    const id = typeof f.id === 'string' && /^[\w-]{1,40}$/.test(f.id) && !ids.has(f.id) ? f.id : randomId((x) => ids.has(x));
    ids.add(id);
    return { id, caption: String(f.caption == null ? '' : f.caption).slice(0, 300), place: FIG_PLACES[f.place] ? f.place : 'appendix', src: f.src, w: +f.w || 0, h: +f.h || 0 };
  });
}
export const figList = (P) => (P.report && Array.isArray(P.report.figures) ? P.report.figures : []);
export const userFigures = (P) => figList(P).filter((f) => f && typeof f.src === 'string' && DATA_IMG.test(f.src));
export const newFigureId = (F) => randomId((x) => F.some((y) => y.id === x));
export const captionOf = (name) => name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 300);

// Scale an image file to at most 1,800 px on the long side. PNG stays PNG (drawings) unless it gets large; photos become JPEG.
export async function shrinkImage(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1800 / Math.max(bmp.width, bmp.height)), c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
  const g = c.getContext('2d');
  const draw = (white) => { g.clearRect(0, 0, c.width, c.height); if (white) { g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); } g.drawImage(bmp, 0, 0, c.width, c.height); };
  let src = '';
  if (file.type === 'image/png') { draw(false); src = c.toDataURL('image/png'); }
  if (!src || src.length > 2.5e6) { draw(true); src = c.toDataURL('image/jpeg', 0.85); }
  if (bmp.close) bmp.close();
  return { src, w: c.width, h: c.height };
}
