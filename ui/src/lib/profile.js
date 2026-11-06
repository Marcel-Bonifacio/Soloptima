// How a profile is shown: its picture (a data URL of an image, nothing else) or its initials on a colour of its own
import { hash } from './format.js';

const COLORS = ['#0f7466', '#2a78d6', '#b5760a', '#6250d6', '#c2416c', '#1e7b34', '#8a5a00', '#3d6b8f'];
const AVATAR = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;

export const avatarPic = (u) => (u && AVATAR.test(u.avatar || '') ? u.avatar : '');
export const colorOf = (id) => COLORS[hash(id) % COLORS.length];
export const initials = (name) => (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
export const firstName = (name) => String(name || '').split(/\s+/)[0];

// A profile picture: the centre square of the image at 160 px. PNG keeps its transparency; other images become JPEG.
export async function avatarImage(file) {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('not an image');
  const bmp = await createImageBitmap(file), s = Math.min(bmp.width, bmp.height), c = document.createElement('canvas');
  c.width = c.height = 160;
  const g = c.getContext('2d'), png = file.type === 'image/png';
  if (!png) { g.fillStyle = '#fff'; g.fillRect(0, 0, 160, 160); }
  g.drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, 160, 160);
  if (bmp.close) bmp.close();
  return c.toDataURL(png ? 'image/png' : 'image/jpeg', 0.88);
}
