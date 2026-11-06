// The figures a user adds to the report, and the satellite-image option (both saved in the project as P.report)
import { queueSave } from './projects.svelte.js';
import { rep, previewLater } from './report.svelte.js';
import { MAX_FIGURES, shrinkImage, newFigureId, captionOf, FIG_PLACES } from './report/figures.js';
import { toast } from './toast.js';
import { W } from './ws/state.js';

const P = () => W.P;
const changed = (ms = 700) => { rep.rev++; queueSave(); previewLater(ms); };

export function setImagery(on) { P().report.imagery = !!on; changed(300); }
export async function addFigures(files) {
  const rp = P().report;
  if (!Array.isArray(rp.figures)) rp.figures = [];
  const F = rp.figures;
  for (const f of files) {
    if (F.length >= MAX_FIGURES) { toast(`A project holds at most ${MAX_FIGURES} figures.`, true); break; }
    if (!/^image\/(png|jpeg|webp)$/.test(f.type)) { toast(`${f.name}: use a PNG, JPEG or WebP image.`, true); continue; }
    let s;
    try { s = await shrinkImage(f); } catch (e) { toast(`${f.name}: the image could not be read.`, true); continue; }
    if (F.reduce((n, x) => n + x.src.length, 0) + s.src.length > 15e6) { toast('The figures would take more than 15 MB in the project file. Use smaller images.', true); break; }
    F.push({ id: newFigureId(F), caption: captionOf(f.name), place: 'appendix', src: s.src, w: s.w, h: s.h });
  }
  changed();
}
export function setField(i, key, value) {
  const f = P().report.figures[i];
  if (!f) return;
  if (key === 'caption') f.caption = String(value).slice(0, 300);
  else if (key === 'place' && FIG_PLACES[value]) f.place = value;
  queueSave(); previewLater(700);   // no structure changed: the list is not redrawn, so focus stays where it is
}
export function move(i, d) {
  const F = P().report.figures, j = i + d;
  if (j < 0 || j >= F.length) return;
  [F[i], F[j]] = [F[j], F[i]];
  changed();
}
export function remove(i) { P().report.figures.splice(i, 1); changed(); }
