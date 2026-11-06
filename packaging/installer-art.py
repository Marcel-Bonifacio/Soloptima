#!/usr/bin/env python3
"""The Windows setup program's pictures, in the style of the macOS disk image background (src-tauri/dmg/background.tiff):
a sky, the sun, a green hill and PV panels in the brand colours.
    python3 packaging/installer-art.py
writes src-tauri/windows/sidebar.bmp (164 x 314, the welcome and finish pages) and src-tauri/windows/header.bmp
(150 x 57, the other pages). Needs Pillow. Drawn at 4x and scaled down for smooth edges; saved as 24-bit BMP, the format
the setup program reads."""
from pathlib import Path
from PIL import Image, ImageDraw

SUN, NAVY = (0xF5, 0x9E, 0x0B), (0x1B, 0x27, 0x40)
SKY_TOP, SKY_BOTTOM = (0xE6, 0xF0, 0xFA), (0xF6, 0xF9, 0xFD)
HILL_BACK, HILL_FRONT = (0xA8, 0xCF, 0x9A), (0x78, 0xAF, 0x76)
POST = (0x5A, 0x5C, 0x58)
S = 4   # drawing scale


def sky(w, h):
    im = Image.new('RGB', (w * S, h * S))
    d = ImageDraw.Draw(im)
    for y in range(h * S):
        t = y / (h * S - 1)
        d.line([(0, y), (w * S, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(SKY_TOP, SKY_BOTTOM)))
    return im, d


def sun(d, cx, cy, r):
    """A disc with twelve short rays, as on the disk image"""
    import math
    cx, cy, r = cx * S, cy * S, r * S
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=SUN)
    for k in range(12):
        a = k * math.pi / 6
        r1, r2 = r * 1.35, r * 1.75
        d.line([(cx + r1 * math.cos(a), cy + r1 * math.sin(a)), (cx + r2 * math.cos(a), cy + r2 * math.sin(a))],
               fill=SUN, width=max(1, round(r * 0.22)))


def hill(d, w, h, top, sag, colour):
    """A gentle hill: a wide ellipse whose crest is `top` px from the image top"""
    d.ellipse([-w * S * 0.6, top * S, w * S * 1.6, (top + sag * 2 + h) * S], fill=colour)


def panel(d, x, y, pw, ph):
    """A tilted navy PV table with white cell lines on a short post; (x, y) is the top left corner"""
    x, y, pw, ph = x * S, y * S, pw * S, ph * S
    d.line([(x + pw / 2, y + ph * 0.8), (x + pw / 2, y + ph * 1.45)], fill=POST, width=max(1, round(S * 1.2)))
    skew = pw * 0.08
    d.polygon([(x + skew, y), (x + pw, y), (x + pw - skew, y + ph), (x, y + ph)], fill=NAVY)
    line = (0xE8, 0xEE, 0xF6)
    for i in range(1, 4):   # columns
        f = i / 4
        d.line([(x + skew + (pw - skew) * f, y), (x + (pw - skew) * f, y + ph)], fill=line, width=max(1, S // 2))
    d.line([(x + skew / 2, y + ph / 2), (x + pw - skew / 2, y + ph / 2)], fill=line, width=max(1, S // 2))


def save(im, w, h, path):
    im.resize((w, h), Image.LANCZOS).convert('RGB').save(path, 'BMP')
    print(path, f'{w}x{h}')


def main():
    out = Path(__file__).resolve().parent.parent / 'src-tauri' / 'windows'

    w, h = 164, 314   # MUI welcome and finish pages
    im, d = sky(w, h)
    sun(d, 112, 62, 17)
    hill(d, w, h, 238, 20, HILL_BACK)
    for x, y in ((28, 236), (66, 238), (104, 241)):
        panel(d, x, y, 30, 15)
    d.ellipse([-w * S * 0.5, 258 * S, w * S * 1.9, (258 + 160) * S], fill=HILL_FRONT)
    save(im, w, h, out / 'sidebar.bmp')

    w, h = 150, 57    # MUI page header, shown at its left
    im, d = sky(w, h)
    sun(d, 30, 22, 9)
    d.ellipse([-w * S * 0.4, 40 * S, w * S * 1.6, (40 + 120) * S], fill=HILL_BACK)
    for x, y in ((62, 34), (92, 36)):
        panel(d, x, y, 24, 11)
    d.ellipse([-w * S * 0.3, 48 * S, w * S * 2.2, (48 + 100) * S], fill=HILL_FRONT)
    save(im, w, h, out / 'header.bmp')


if __name__ == '__main__':
    main()
