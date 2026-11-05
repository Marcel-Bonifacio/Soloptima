#!/usr/bin/env python3
"""Draw docs/readme/hero.svg from a Soloptima simulation of the example project.

The chart in the hero is real engine output, not an illustration. To redraw it after the model changes:

    ./soloptima simulate web/examples/example_study.json /tmp/example-results.json
    python3 docs/readme/source/make_hero.py /tmp/example-results.json

The wordmark is copied from docs/brand/soloptima-logo-navy.svg, so the hero follows the brand files.
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DAY = 298          # day of year 1 shown in the chart (0-based); every hour of it is read from the results
W, H = 1200, 440

NAVY, CARD, RULE = "#1B2740", "#223150", "#2F3F60"
WHITE, SOFT, MUTED = "#FFFFFF", "#C9D1E0", "#8FA0BD"
AMBER = "#F59E0B"
DIESEL, BATTERY, CHARGING, CURTAILED = "#2A78D6", "#1BAF7A", "#8FE3C3", "#E87BA4"

SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"


def logo_inner() -> str:
    """The navy logo without its background rectangle: white wordmark, amber sun, tagline."""
    svg = (ROOT / "docs/brand/soloptima-logo-navy.svg").read_text(encoding="utf-8")
    body = svg[svg.index(">") + 1: svg.rindex("</svg>")]
    return re.sub(r"<rect[^>]*/>", "", body, count=1).strip()


def chart(hourly: dict) -> str:
    x0, x1, yb, yt, top_mw = 712, 1128, 296, 112, 32
    pitch = (x1 - x0) / 24
    bar = pitch - 3.6
    k = (yb - yt) / (top_mw * 1000)          # px per kW
    out = []
    for mw in (0, 10, 20, 30):
        y = yb - mw * 1000 * k
        out.append(f'<line x1="{x0}" y1="{y:.1f}" x2="{x1}" y2="{y:.1f}" stroke="{RULE}" stroke-width="1"/>')
        label = f"{mw} MW" if mw == 30 else str(mw)
        out.append(f'<text x="{x0 - 10}" y="{y + 5:.1f}" text-anchor="end" font-family="{MONO}" font-size="15" fill="{MUTED}">{label}</text>')
    series = [("gen_to_load", DIESEL, 1), ("bess_dis", BATTERY, 1), ("pv_to_load", AMBER, 1),
              ("pv_to_bess", CHARGING, 1), ("pv_curtailed", CURTAILED, 1)]
    for i in range(24):
        t = DAY * 24 + i
        x = x0 + i * pitch + (pitch - bar) / 2
        base = 0.0
        for key, color, alpha in series:
            v = float(hourly[key][t])
            if v <= 0:
                continue
            y = yb - (base + v) * k
            op = "" if alpha == 1 else f' fill-opacity="{alpha}"'
            out.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{bar:.1f}" height="{v * k:.1f}" fill="{color}"{op}/>')
            base += v
    for hr in (0, 6, 12, 18, 24):
        out.append(f'<text x="{x0 + hr * pitch:.1f}" y="322" text-anchor="middle" font-family="{MONO}" font-size="16" fill="{MUTED}">{hr:02d}</text>')
    # Direct labels for the two large areas
    out.append(f'<text x="{x0 + 3 * pitch:.1f}" y="234" text-anchor="middle" font-family="{SANS}" font-size="19" font-weight="600" fill="{WHITE}">Diesel</text>')
    out.append(f'<text x="{x0 + 12 * pitch:.1f}" y="222" text-anchor="middle" font-family="{SANS}" font-size="19" font-weight="700" fill="{NAVY}">PV</text>')
    # Legend for the three thin series
    lx, ly = 664, 362
    for name, color, alpha in (("Battery", BATTERY, 1), ("PV to battery", CHARGING, 1), ("Curtailed", CURTAILED, 1)):
        op = "" if alpha == 1 else f' fill-opacity="{alpha}"'
        out.append(f'<rect x="{lx}" y="{ly - 13}" width="14" height="14" rx="3" fill="{color}"{op}/>')
        out.append(f'<text x="{lx + 22}" y="{ly}" font-family="{SANS}" font-size="18" fill="{SOFT}">{name}</text>')
        lx += 22 + len(name) * 8.9 + 30
    return "\n    ".join(out)


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("usage: make_hero.py results.json")
    hourly = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))["result"]["hourly"]
    svg = f'''<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" aria-labelledby="title desc">
  <title id="title">Soloptima: size hybrid power plants hour by hour</title>
  <desc id="desc">The Soloptima wordmark beside a chart of one simulated day of the example project. Diesel generators carry the load at night; from mid-morning solar PV covers most of it, charges the battery and is partly curtailed; the battery discharges in the late afternoon.</desc>
  <rect width="{W}" height="{H}" rx="24" fill="{NAVY}"/>

  <g id="wordmark" transform="translate(64 58) scale(0.0705)">
    {logo_inner()}
  </g>

  <g id="promise" font-family="{SANS}">
    <text x="64" y="250" font-size="38" font-weight="700" fill="{WHITE}">Size hybrid power plants</text>
    <text x="64" y="294" font-size="38" font-weight="700" fill="{AMBER}">hour by hour.</text>
    <text x="64" y="338" font-size="21" fill="{SOFT}">Solar PV, battery storage and diesel generators,</text>
    <text x="64" y="366" font-size="21" fill="{SOFT}">simulated over the whole project life.</text>
  </g>
  <text x="64" y="406" font-family="{MONO}" font-size="16" letter-spacing="1.5" fill="{MUTED}">WINDOWS · MACOS · LINUX · APACHE 2.0</text>

  <g id="dispatch">
    <rect x="640" y="40" width="512" height="360" rx="16" fill="{CARD}" stroke="{RULE}" stroke-width="1.5"/>
    <text x="664" y="78" font-family="{SANS}" font-size="18" font-weight="500" fill="{SOFT}">Example project · one day of hourly dispatch</text>
    {chart(hourly)}
  </g>
</svg>
'''
    out = ROOT / "docs/readme/hero.svg"
    out.write_text(svg, encoding="utf-8")
    print(f"Wrote {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
