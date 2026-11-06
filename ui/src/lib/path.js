// Dotted paths into the project ('pv.tilt')
export const getPath = (o, path) => path.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
export function setPath(o, path, v) {
  const ks = path.split('.');
  let a = o;
  for (let i = 0; i < ks.length - 1; i++) { if (a[ks[i]] == null || typeof a[ks[i]] !== 'object') a[ks[i]] = {}; a = a[ks[i]]; }
  a[ks[ks.length - 1]] = v;
}
