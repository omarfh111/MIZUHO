"""Generate the script-free animated and reduced-motion README artwork.

Run `python docs/tools/readme_hero.py` from the repository root. The stylized
outline and river follow the cinematic map; the site markers use the catalogue
coordinates. The relief texture is illustrative.
"""
from __future__ import annotations

import json
import math
from pathlib import Path
from xml.sax.saxutils import escape


W, H = 1280, 560
DOCS = Path(__file__).resolve().parents[1]
DATA = DOCS.parent / "data"
OUT = DOCS / "readme-hero.svg"
STILL_OUT = DOCS / "readme-hero-still.svg"

TUNISIA = [
    (8.62, 36.94), (8.76, 36.96), (8.98, 37.02), (9.22, 37.23), (9.52, 37.25), (9.85, 37.34),
    (9.88, 37.25), (10.05, 37.26), (10.18, 37.19), (10.22, 37.07), (10.27, 36.93), (10.31, 36.82),
    (10.36, 36.72), (10.5, 36.71), (10.64, 36.86), (10.88, 37.02), (11.05, 37.08), (11.12, 36.86),
    (10.98, 36.66), (10.73, 36.45), (10.58, 36.37), (10.52, 36.08), (10.57, 35.92), (10.64, 35.83),
    (10.83, 35.77), (11.0, 35.62), (11.06, 35.5), (11.13, 35.24), (11.02, 35.03), (10.84, 34.83),
    (10.74, 34.71), (10.5, 34.53), (10.25, 34.36), (10.1, 34.27), (10.05, 34.08), (10.1, 33.89),
    (10.32, 33.7), (10.47, 33.6), (10.75, 33.48), (11.11, 33.47), (11.2, 33.24), (11.56, 33.17),
    (11.5, 32.66), (11.48, 32.38), (11.03, 32.17), (10.7, 32.02), (10.43, 31.6), (10.28, 31.22),
    (10.1, 30.86), (9.86, 30.54), (9.53, 30.23), (9.36, 30.74), (9.18, 31.5), (9.05, 32.1),
    (8.33, 32.53), (8.08, 32.95), (7.75, 33.25), (7.53, 33.75), (7.52, 34.12), (7.82, 34.25),
    (8.25, 34.65), (8.28, 34.95), (8.31, 35.3), (8.42, 35.73), (8.31, 35.98), (8.36, 36.22),
    (8.4, 36.45), (8.2, 36.5), (8.4, 36.77),
]
DJERBA = [(10.76, 33.88), (10.98, 33.86), (11.07, 33.78), (11.05, 33.66), (10.9, 33.62), (10.75, 33.68), (10.72, 33.8)]
MEDJERDA = [
    (8.36, 36.43), (8.55, 36.46), (8.78, 36.49), (8.95, 36.56), (9.08, 36.62), (9.25, 36.6),
    (9.4, 36.58), (9.5, 36.6), (9.61, 36.66), (9.75, 36.76), (9.86, 36.83), (9.98, 36.9),
    (10.08, 37.0), (10.17, 37.06),
]

# --- isometric projection --------------------------------------------------
ANGLE = math.radians(-24)
SQUASH = 0.62


def raw(lon: float, lat: float) -> tuple[float, float]:
    x, y = lon - 9.6, -(lat - 34.0)
    c, s = math.cos(ANGLE), math.sin(ANGLE)
    return x * c - y * s, (x * s + y * c) * SQUASH


_pts = [raw(*p) for p in TUNISIA]
_minx = min(p[0] for p in _pts); _maxx = max(p[0] for p in _pts)
_miny = min(p[1] for p in _pts); _maxy = max(p[1] for p in _pts)
BOX = (760, 38, 1230, 470)  # target region for the slab, clear of the wordmark
SCALE = min((BOX[2] - BOX[0]) / (_maxx - _minx), (BOX[3] - BOX[1]) / (_maxy - _miny))
OFF_X = BOX[0] + ((BOX[2] - BOX[0]) - (_maxx - _minx) * SCALE) / 2 - _minx * SCALE
OFF_Y = BOX[1] + ((BOX[3] - BOX[1]) - (_maxy - _miny) * SCALE) / 2 - _miny * SCALE


def P(lon: float, lat: float) -> tuple[float, float]:
    x, y = raw(lon, lat)
    return round(x * SCALE + OFF_X, 1), round(y * SCALE + OFF_Y, 1)


def path(points, close=False) -> str:
    d = "M" + " L".join(f"{x},{y}" for x, y in (P(*p) for p in points))
    return d + (" Z" if close else "")


def smooth_path(points) -> str:
    """Catmull-Rom through the projected points, as cubic Béziers."""
    pts = [P(*p) for p in points]
    d = f"M{pts[0][0]},{pts[0][1]}"
    for i in range(len(pts) - 1):
        p0 = pts[max(0, i - 1)]; p1 = pts[i]; p2 = pts[i + 1]; p3 = pts[min(len(pts) - 1, i + 2)]
        c1 = (p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6)
        c2 = (p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6)
        d += f" C{c1[0]:.1f},{c1[1]:.1f} {c2[0]:.1f},{c2[1]:.1f} {p2[0]},{p2[1]}"
    return d


def catalogue_sites():
    pilot = json.loads((DATA / "sites.geojson").read_text(encoding="utf-8"))["features"]
    for site in pilot:
        yield site["properties"]["site_id"], site["geometry"]["coordinates"]

    survey = json.loads((DATA / "agriculture/assila/site.geojson").read_text(encoding="utf-8"))
    yield survey["properties"]["site_id"], survey["properties"]["centroid_lon_lat"]

    for file in sorted((DATA / "field_zones").glob("*.json")):
        site = json.loads(file.read_text(encoding="utf-8"))["site"]
        yield site["properties"]["site_id"], site["geometry"]["coordinates"]


# Printed names are kept to a few well-spaced sites at this scale.
CALLOUTS = {
    "jendouba-pilote": ("Jendouba", -42, 32, "end"),
    "korba-cap-bon": ("Korba", 55, 7, "start"),
    "gafsa-oasis": ("Gafsa", -44, 35, "end"),
}

ANIMATION = """
@keyframes outline { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
@keyframes water { to { stroke-dashoffset: -.2; } }
@keyframes locate { from { transform: scale(.5); opacity: .85; } to { transform: scale(2.5); opacity: 0; } }
@keyframes light { from { transform: translate(-360px, 80px); } to { transform: translate(360px, -80px); } }
@keyframes signal { 0%,100% { transform: scaleY(.55); } 50% { transform: scaleY(1); } }
@media (prefers-reduced-motion: no-preference) {
  .coast { stroke-dasharray: 1; animation: outline 2.8s cubic-bezier(.34,.68,.24,1) both; }
  .current { animation: water 3.4s linear infinite; }
  .pulse { transform-box: fill-box; transform-origin: center; animation: locate 4s ease-out infinite; }
  .light { display: inline; animation: light 9s ease-in-out infinite alternate; }
  .bar { transform-box: fill-box; transform-origin: center; animation: signal 1.7s ease-in-out infinite; }
}
"""


def build(*, animated: bool = True) -> str:
    land = path(TUNISIA, close=True)
    island = path(DJERBA, close=True)
    river = smooth_path(MEDJERDA)
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" role="img" aria-labelledby="title desc">',
           '<title id="title">MIZUHO · Irrigation planning for Tunisia</title>',
           '<desc id="desc">An illustrated map marks Tunisian study sites including Jendouba, Korba and Gafsa. '
           'MIZUHO compares irrigation plans under water and power limits and explains them through its digital twin and Voice Guardian.</desc>']
    add = out.append
    add("""<style>
text { font-family: 'Segoe UI', Arial, sans-serif; }
.word { font-size: 139px; font-weight: 750; letter-spacing: -7px; }
.head { font-size: 21px; font-weight: 650; letter-spacing: 3.2px; }
.line { font-size: 43px; font-weight: 550; letter-spacing: -.8px; }
.caption { font-size: 20px; font-weight: 600; }
.mapLabel { font-size: 23px; font-weight: 650; paint-order: stroke; stroke: #111e18; stroke-width: 5px; stroke-linejoin: round; }
.light { display: none; } .pulse { opacity: 0; }
@media (max-width: 650px) {
  .detail { display: none; }
  .head { font-size: 36px; letter-spacing: 2px; }
  .word { font-size: 158px; }
  .line { font-size: 51px; }
}""")
    if animated:
        add(ANIMATION)
    add("""</style>
<defs>
  <linearGradient id="ground" x1="0" y1="0" x2="1" y2="1">
    <stop stop-color="#10261e"/><stop offset=".55" stop-color="#101d18"/><stop offset="1" stop-color="#0b1713"/>
  </linearGradient>
  <radialGradient id="halo">
    <stop stop-color="#6d8c58" stop-opacity=".35"/><stop offset="1" stop-color="#6d8c58" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="land" gradientUnits="userSpaceOnUse" x1="880" y1="30" x2="1120" y2="480">
    <stop stop-color="#607a4d"/><stop offset=".3" stop-color="#789361"/><stop offset=".62" stop-color="#a99963"/><stop offset="1" stop-color="#d7b17c"/>
  </linearGradient>
  <linearGradient id="type" x1="0" y1="0" x2="1" y2=".4">
    <stop stop-color="#edf9d7"/><stop offset=".67" stop-color="#d4f785"/><stop offset="1" stop-color="#a9dc81"/>
  </linearGradient>
  <linearGradient id="scan">
    <stop stop-color="#f8ffe3" stop-opacity="0"/><stop offset=".56" stop-color="#f8ffe3" stop-opacity=".22"/><stop offset="1" stop-color="#f8ffe3" stop-opacity="0"/>
  </linearGradient>
  <pattern id="grid" width="56" height="56" patternUnits="userSpaceOnUse">
    <path d="M56 0H0V56" fill="none" stroke="#deecca" stroke-opacity=".07"/>
    <circle r="1.3" fill="#dae8c6" fill-opacity=".14"/>
  </pattern>
  <pattern id="fields" width="23" height="23" patternUnits="userSpaceOnUse" patternTransform="rotate(-19)">
    <path d="M0 0H23M0 6H23M0 12H23M0 18H23" fill="none" stroke="#f4f3d4" stroke-width=".8" opacity=".2"/>
  </pattern>
  <filter id="shadow" x="-.25" y="-.25" width="1.5" height="1.6"><feGaussianBlur stdDeviation="11"/></filter>""")
    add(f'<path id="mainland" d="{land}"/><path id="djerba" d="{island}"/>')
    add(f'<clipPath id="surface"><path d="{land}"/><path d="{island}"/></clipPath></defs>')
    add(f'<rect width="{W}" height="{H}" fill="url(#ground)"/>')
    add('<ellipse cx="972" cy="220" rx="510" ry="390" fill="url(#halo)"/>')
    add(f'<rect width="{W}" height="{H}" fill="url(#grid)"/>')

    # The scene shares the cinematic map projection. Layers give the land thickness.
    add('<use href="#mainland" transform="translate(0 36)" fill="#020905" opacity=".65" filter="url(#shadow)"/>')
    for depth, color in ((19, "#334b39"), (14, "#4e6041"), (8, "#657347"), (4, "#83915d")):
        add(f'<use href="#mainland" transform="translate(0 {depth})" fill="{color}" stroke="{color}"/>')
    add('<use href="#djerba" transform="translate(0 5)" fill="#445841"/>')
    add('<use href="#mainland" fill="url(#land)"/><use href="#djerba" fill="url(#land)"/>')
    add('<g clip-path="url(#surface)">')
    add(f'<rect x="720" y="15" width="550" height="505" fill="url(#fields)"/>')

    # A cartographic engraving, kept visibly distinct from a measured elevation layer.
    for ridge in range(-4, 28):
        y = 4 + ridge * 17
        add(f'<path d="M714 {y}q82 30 135 -1t118 0t142 7t158 -2" fill="none" '
            'stroke="#354a37" stroke-width="1.4" opacity=".25"/>')
    add(f'<path d="{river}" fill="none" stroke="#1b564a" stroke-width="6" stroke-linecap="round"/>')
    add(f'<path d="{river}" fill="none" stroke="#a9e7d2" stroke-width="3" stroke-linecap="round"/>')
    add(f'<path class="current" pathLength="1" d="{river}" fill="none" stroke="#edfdef" '
        'stroke-width="2" stroke-dasharray=".035 .065" stroke-linecap="round"/>')
    add('<g class="light"><path d="M890 -20h140l125 550h-140Z" fill="url(#scan)"/></g></g>')
    for shape in (land, island):
        add(f'<path class="coast" d="{shape}" pathLength="1" stroke="#e3f4c3" stroke-width="1.8" fill="none"/>')

    for site_id, coordinates in catalogue_sites():
        x, y = P(*coordinates)
        color = "#d4f785" if site_id == "jendouba-pilote" else "#e7f7ec"
        add(f'<g><title>{escape(site_id)}</title>')
        if site_id == "jendouba-pilote":
            add(f'<circle class="pulse" cx="{x}" cy="{y}" r="10" fill="none" stroke="#ddffa1" stroke-width="2"/>')
        add(f'<circle cx="{x}" cy="{y}" r="5.6" fill="{color}" stroke="#1c392c" stroke-width="2.8"/>')
        if site_id in CALLOUTS:
            name, dx, dy, anchor = CALLOUTS[site_id]
            direction = 1 if dx > 0 else -1
            end_x, end_y = x + dx, y + dy
            add(f'<g class="detail"><path d="M{x + 7 * direction} {y + 3} L{end_x - direction * 12} {end_y} H{end_x}" '
                f'fill="none" stroke="{color}" stroke-width="1.4"/>'
                f'<text x="{end_x + direction * 6}" y="{end_y + 7}" class="mapLabel" text-anchor="{anchor}" fill="{color}">{name}</text></g>')
        add('</g>')

    # Left-aligned wording stays visible on the first frame and on small screens.
    add('<g transform="translate(70 78)" fill="none" stroke="#d4f785" stroke-width="3.6" stroke-linecap="round">')
    for y in (0, 8, 16):
        add(f'<path d="M0 {y}q5 -4 10 0t10 0t10 0"/>')
    add('</g><text class="head" x="119" y="97" fill="#bbd6bc">TUNISIA</text>')
    add('<text x="63" y="251" class="word" fill="url(#type)">MIZUHO</text>')
    add('<g fill="#eef4e9" class="line"><text x="70" y="337">Plan irrigation around</text>'
        '<text x="70" y="397">water and power limits.</text></g>')
    add('<g class="detail"><path d="M70 444h584" stroke="#5b7560" stroke-opacity=".6"/>')
    add('<text x="70" y="489" class="caption" fill="#c0d1bf">Plan comparison</text>'
        '<text x="266" y="489" class="caption" fill="#c0d1bf">Digital twin</text>'
        '<text x="456" y="489" class="caption" fill="#c0d1bf">Voice Guardian</text>')
    add('<path d="M246 475v16m134 -16v16" stroke="#6b806d"/>')
    for index, height in enumerate((7, 16, 24, 12, 19)):
        x = 407 + index * 6
        add(f'<path class="bar" d="M{x} {482 - height / 2}v{height}" stroke="#83e2ca" stroke-width="3.2" '
            f'stroke-linecap="round" style="animation-delay:-{index * .14:.2f}s"/>')
    add('</g></svg>')
    return "\n".join(out) + "\n"


if __name__ == "__main__":
    for output, animated in ((OUT, True), (STILL_OUT, False)):
        output.write_text(build(animated=animated), encoding="utf-8", newline="\n")
        print(f"wrote {output.name} ({output.stat().st_size:,} bytes)")
