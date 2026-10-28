#!/usr/bin/env python3
"""Draw the Soloptima app icon (the logo mark: a sun drawn as a PV cell, on a navy tile; same artwork as
docs/brand/soloptima-icon.svg and the favicon) without any third-party library, and write it as a 1024 px PNG
plus a Windows .ico.

    python3 make_icons.py OUT_DIR          -> OUT_DIR/icon_1024.png, OUT_DIR/Soloptima.ico

The .ico embeds PNG frames (16-256 px), each rendered at its own size with supersampling, so it needs
no resizing tool either. The macOS .icns is assembled from icon_1024.png by build-mac.sh (sips + iconutil).
"""
import math
import os
import struct
import sys
import zlib

NAVY, AMBER, WHITE = (27, 39, 64), (245, 158, 11), (255, 255, 255)
RAYS = [(math.cos(math.radians(a)), math.sin(math.radians(a))) for a in range(0, 360, 45)]


def shade(x, y, inset):
    """Colour (r, g, b) of a point in the 100-unit artwork space, or None outside the tile.
    Geometry as in soloptima-icon.svg: tile radius 22, disc radius 23, cell lines at 0.36 R, rays R+7 to R+17."""
    lo, hi = inset, 100 - inset
    k = (hi - lo) / 100                                                    # the mark scales with the tile
    r = 22 * k
    if not (lo <= x <= hi and lo <= y <= hi):
        return None
    cx, cy = min(max(x, lo + r), hi - r), min(max(y, lo + r), hi - r)   # rounded corners
    if (x - cx) ** 2 + (y - cy) ** 2 > r * r:
        return None
    u, v = (x - 50) / k, (y - 50) / k                                     # mark coordinates
    R = 23
    if u * u + v * v <= R * R:                                             # disc with a 3 x 3 cell grid
        g = 0.06 * R
        if abs(abs(u) - 0.36 * R) < g or abs(abs(v) - 0.36 * R) < g:
            return WHITE
        return AMBER
    for c, s in RAYS:                                                      # rays: capsules of width 6.2
        t = min(max(u * c + v * s, R + 7), R + 17)
        if (u - t * c) ** 2 + (v - t * s) ** 2 <= 3.1 ** 2:
            return AMBER
    return NAVY


def render(size, inset, ss=4):
    """RGBA rows, `ss` x `ss` supersampled."""
    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(ss):
                for sx in range(ss):
                    c = shade((px + (sx + 0.5) / ss) * 100 / size, (py + (sy + 0.5) / ss) * 100 / size, inset)
                    if c:
                        acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; acc[3] += 1
            n = acc[3]
            row += bytes((acc[0] // n, acc[1] // n, acc[2] // n, 255 * n // (ss * ss))) if n else b"\0\0\0\0"
        rows.append(bytes(row))
    return rows


def png(rows):
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    size = len(rows)
    raw = b"".join(b"\0" + r for r in rows)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def ico(frames):
    """frames: list of (size, png bytes)."""
    head = struct.pack("<HHH", 0, 1, len(frames))
    offset, entries, blobs = 6 + 16 * len(frames), b"", b""
    for size, data in frames:
        dim = 0 if size >= 256 else size
        entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
        blobs += data
    return head + entries + blobs


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "."
    os.makedirs(out, exist_ok=True)
    # macOS: Big Sur grid leaves ~10 % transparent margin around the tile; Windows: nearly full bleed
    with open(os.path.join(out, "icon_1024.png"), "wb") as f:
        f.write(png(render(1024, inset=10, ss=2)))
    frames = [(s, png(render(s, inset=1.5))) for s in (16, 24, 32, 48, 64, 128, 256)]
    with open(os.path.join(out, "Soloptima.ico"), "wb") as f:
        f.write(ico(frames))


if __name__ == "__main__":
    main()
