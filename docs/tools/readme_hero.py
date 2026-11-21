"""Generate docs/readme-hero.svg: the animated README banner.

Run from the repository root:  python docs/tools/readme_hero.py

The banner is pure SVG + CSS animation, so it plays inside GitHub's image
renderer (no script). Tunisia is drawn as a floating isometric slab from the
same simplified outline the cinematic uses; positions are approximate.
Every animated element's resting style is its final frame, so
`readme-hero.svg#still` and `prefers-reduced-motion` show a complete still.
"""
from __future__ import annotations

import math
import random
from pathlib import Path

W, H = 1280, 560
OUT = Path(__file__).resolve().parents[1] / "readme-hero.svg"

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
DAMS = [(9.41, 36.58), (8.74, 36.63), (8.73, 36.3), (9.07, 37.03), (10.02, 35.95)]
JENDOUBA = (8.78, 36.5)
TOZEUR = (8.13, 33.92)
WIND = [(10.9, 37.02), (9.72, 37.2)]

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


def build() -> str:
    rnd = random.Random(2026)
    land = path(TUNISIA, close=True)
    djerba = path(DJERBA, close=True)
    river = smooth_path(MEDJERDA)
    north, south = P(9.6, 37.3), P(9.6, 30.4)
    jx, jy = P(*JENDOUBA)
    tx, ty = P(*TOZEUR)

    out: list[str] = []
    add = out.append
    add(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" role="img" aria-labelledby="title description">')
    add('<title id="title">MIZUHO · Renewable-powered water intelligence for Tunisian agriculture</title>')
    add('<desc id="description">An animated isometric map of Tunisia: a raindrop falls on the Jendouba pilot, '
        'light flows down the Medjerda, reservoirs pulse, wind turbines turn and the Tozeur sun glows, '
        'beside the MIZUHO wordmark and its three modules.</desc>')

    add("""<style>
  .t { font-family: 'Space Grotesk', 'Segoe UI', Inter, Helvetica, Arial, sans-serif; }
  .b { font-family: Manrope, 'Segoe UI', Inter, Helvetica, Arial, sans-serif; }
  @keyframes draw { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
  @keyframes rise { from { opacity: 0; transform: translateY(26px); } to { opacity: 1; transform: none; } }
  @keyframes fadein { from { opacity: 0; } to { opacity: 1; } }
  @keyframes flow { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
  @keyframes travel { from { offset-distance: 0%; opacity: 0; } 10% { opacity: 1; } 90% { opacity: 1; } to { offset-distance: 100%; opacity: 0; } }
  @keyframes ring { 0% { transform: scale(.25); opacity: .95; } 100% { transform: scale(3.4); opacity: 0; } }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes breathe { 0%, 100% { opacity: .55; } 50% { opacity: 1; } }
  @keyframes twinkle { 0%, 100% { opacity: .15; } 50% { opacity: .9; } }
  @keyframes drift { from { transform: translateY(0); } to { transform: translateY(-40px); } }
  @keyframes fall { 0% { transform: translateY(-330px) scale(1.3); opacity: 0; } 8% { opacity: 1; }
                    30% { transform: translateY(0) scale(1); opacity: 1; } 33%, 100% { transform: translateY(0) scale(.2); opacity: 0; } }
  @keyframes splash { 0%, 30% { transform: scale(.1); opacity: 0; } 32% { opacity: 1; } 75%, 100% { transform: scale(1); opacity: 0; } }
  @keyframes sweep { 0% { transform: translateX(-620px) skewX(-18deg); } 100% { transform: translateX(760px) skewX(-18deg); } }
  @keyframes shimmer { 0%, 55% { transform: translateX(-560px); } 100% { transform: translateX(620px); } }
  .coast { stroke-dasharray: 1; animation: draw 3.2s cubic-bezier(.65,0,.35,1) both; }
  .slab { animation: rise 1.6s cubic-bezier(.2,.8,.2,1) both; }
  .fade1 { animation: fadein 1.2s ease .4s both; }
  .fade2 { animation: fadein 1.2s ease 1.4s both; }
  .fade3 { animation: fadein 1.2s ease 2.2s both; }
  .riverflow { stroke-dasharray: .045 .055; animation: flow 3.6s linear infinite; }
  .pulse { offset-path: path('""" + river + """'); offset-rotate: 0deg; animation: travel 4.8s cubic-bezier(.45,0,.55,1) infinite; opacity: 0; }
  .ring { transform-box: fill-box; transform-origin: center; animation: ring 3.2s cubic-bezier(.2,.7,.3,1) infinite; opacity: 0; }
  .rotor { transform-box: view-box; animation: spin 3.4s linear infinite; }
  .rays { transform-box: fill-box; transform-origin: center; animation: spin 26s linear infinite; }
  .breathe { animation: breathe 4.5s ease-in-out infinite; }
  .star { animation: twinkle 3s ease-in-out infinite; }
  .mote { animation: drift 9s linear infinite alternate; }
  .drop { transform-box: fill-box; transform-origin: 50% 100%; animation: fall 5.5s cubic-bezier(.55,0,.85,.35) 1.2s infinite; opacity: 0; }
  .splash { transform-box: fill-box; transform-origin: center; animation: splash 5.5s cubic-bezier(.2,.7,.3,1) 1.2s infinite; opacity: 0; }
  .sweep { animation: sweep 7s cubic-bezier(.45,0,.55,1) 1s infinite; }
  .shimmer { animation: shimmer 6s cubic-bezier(.45,0,.55,1) 1.5s infinite; }
  .rise1 { animation: rise 1.1s cubic-bezier(.2,.8,.2,1) .15s both; }
  .rise2 { animation: rise 1.1s cubic-bezier(.2,.8,.2,1) .35s both; }
  .rise3 { animation: rise 1.1s cubic-bezier(.2,.8,.2,1) .6s both; }
  .rise4 { animation: rise 1.1s cubic-bezier(.2,.8,.2,1) .85s both; }
  /* Still frame: reduced motion, or the #still fragment. Resting styles are the final frame. */
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; } .loop { display: none; } }
  #still:target ~ *, #still:target ~ * * { animation: none !important; }
  #still:target ~ .loop, #still:target ~ * .loop { display: none; }
</style>""")

    # ---------------------------------------------------------------- defs
    add(f"""<defs>
  <linearGradient id="sky" x1="0" y1="0" x2="1" y2="1">
    <stop stop-color="#030b0b"/><stop offset=".55" stop-color="#071a19"/><stop offset="1" stop-color="#0b1f1c"/>
  </linearGradient>
  <radialGradient id="glowWater" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate({jx} {jy + 40}) scale(420 260)">
    <stop stop-color="#62e3f0" stop-opacity=".22"/><stop offset="1" stop-color="#62e3f0" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="glowSun" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate({tx} {ty}) scale(260 180)">
    <stop stop-color="#f7ce76" stop-opacity=".3"/><stop offset="1" stop-color="#f7ce76" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="glowLeaf" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(180 520) scale(520 260)">
    <stop stop-color="#c9ef86" stop-opacity=".1"/><stop offset="1" stop-color="#c9ef86" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="landTop" gradientUnits="userSpaceOnUse" x1="{north[0]}" y1="{north[1]}" x2="{south[0]}" y2="{south[1]}">
    <stop stop-color="#2f5d3c"/><stop offset=".32" stop-color="#4f6a3a"/><stop offset=".55" stop-color="#8a7d4c"/><stop offset="1" stop-color="#c79858"/>
  </linearGradient>
  <linearGradient id="word" x1="0" y1="0" x2="1" y2="0">
    <stop stop-color="#62e3f0"/><stop offset=".5" stop-color="#c9ef86"/><stop offset="1" stop-color="#f7ce76"/>
  </linearGradient>
  <linearGradient id="band" x1="0" y1="0" x2="1" y2="0">
    <stop stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".75"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
  </linearGradient>
  <linearGradient id="scan" x1="0" y1="0" x2="1" y2="0">
    <stop stop-color="#62e3f0" stop-opacity="0"/><stop offset=".5" stop-color="#b8fbff" stop-opacity=".35"/><stop offset="1" stop-color="#62e3f0" stop-opacity="0"/>
  </linearGradient>
  <radialGradient id="vignette" cx=".5" cy=".5" r=".75">
    <stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".55"/>
  </radialGradient>
  <filter id="blur6" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6"/></filter>
  <filter id="blur2" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2"/></filter>
  <filter id="shadow" x="-30%" y="-30%" width="160%" height="180%"><feGaussianBlur stdDeviation="14"/></filter>
  <clipPath id="landClip"><path d="{land}"/><path d="{djerba}"/></clipPath>
  <clipPath id="wordClip"><text x="68" y="262" class="t" font-size="138" font-weight="700" letter-spacing="-5">MIZUHO</text></clipPath>
</defs>""")
    add('<g id="still"/>')

    # ------------------------------------------------------- atmosphere
    add(f'<rect width="{W}" height="{H}" fill="url(#sky)"/>')
    add(f'<rect width="{W}" height="{H}" fill="url(#glowLeaf)"/>')
    add(f'<rect width="{W}" height="{H}" fill="url(#glowWater)" class="breathe"/>')
    add(f'<rect width="{W}" height="{H}" fill="url(#glowSun)"/>')
    stars = []
    for _ in range(70):
        x, y = rnd.uniform(0, W), rnd.uniform(0, H)
        r = rnd.choice([0.6, 0.8, 1, 1.2, 1.6])
        color = rnd.choice(["#b8fbff", "#b8fbff", "#c9ef86", "#f7ce76"])
        stars.append(f'<circle class="star" cx="{x:.0f}" cy="{y:.0f}" r="{r}" fill="{color}" '
                     f'style="animation-delay:{rnd.uniform(0, 3):.2f}s;animation-duration:{rnd.uniform(2.2, 5):.1f}s"/>')
    add('<g opacity=".8">' + "".join(stars) + "</g>")

    # ------------------------------------------------------- the slab
    add('<g class="slab">')
    # Drop shadow under the floating country.
    add(f'<path d="{land}" transform="translate(0 46)" fill="#000" opacity=".55" filter="url(#shadow)"/>')
    # Extruded edge: stacked copies, darkest at the bottom.
    for i in range(10, 0, -1):
        add(f'<path d="{land}" transform="translate(0 {i * 2.1:.1f})" fill="rgb({8 + i},{30 + i * 2},{32 + i * 2})"/>')
    add(f'<path d="{djerba}" transform="translate(0 6)" fill="#0d2a2a"/>')
    add(f'<path d="{land}" fill="url(#landTop)"/>')
    add(f'<path d="{djerba}" fill="url(#landTop)"/>')

    # Inside the land: graticule, relief speckle, the satellite scan.
    add('<g clip-path="url(#landClip)">')
    grid = []
    for lon in range(7, 13):
        grid.append(path([(lon, 29.5), (lon, 38)]))
    for lat in range(30, 38):
        grid.append(path([(7, lat), (12, lat)]))
    add('<g stroke="#62e3f0" stroke-opacity=".16" stroke-width=".8" fill="none">' + "".join(f'<path d="{d}"/>' for d in grid) + "</g>")
    speck = []
    for _ in range(420):
        lon, lat = rnd.uniform(7.4, 11.6), rnd.uniform(30.2, 37.4)
        x, y = P(lon, lat)
        north_ness = (lat - 30) / 7.4
        color = "#c9ef86" if north_ness > 0.7 and rnd.random() < 0.6 else "#f2d7a0"
        speck.append(f'<circle cx="{x}" cy="{y}" r="{rnd.uniform(.4, 1.1):.1f}" fill="{color}" opacity="{rnd.uniform(.08, .28):.2f}"/>')
    add("<g>" + "".join(speck) + "</g>")
    add(f'<rect class="sweep loop" x="{BOX[0] - 80}" y="0" width="160" height="{H}" fill="url(#scan)"/>')
    add("</g>")

    # Coastline: soft glow + crisp line drawn on.
    add(f'<path d="{land}" fill="none" stroke="#62e3f0" stroke-width="5" opacity=".35" filter="url(#blur6)"/>')
    add(f'<path class="coast" pathLength="1" d="{land}" fill="none" stroke="#9ff3fb" stroke-width="1.6" stroke-linejoin="round"/>')
    add(f'<path class="coast" pathLength="1" d="{djerba}" fill="none" stroke="#9ff3fb" stroke-width="1.2"/>')

    # The Medjerda: glowing bed, flowing dashes, a travelling light.
    add(f'<path d="{river}" fill="none" stroke="#62e3f0" stroke-width="6" opacity=".35" filter="url(#blur2)"/>')
    add(f'<path d="{river}" fill="none" stroke="#3cc7d8" stroke-width="2" stroke-linecap="round"/>')
    add(f'<path class="riverflow" pathLength="1" d="{river}" fill="none" stroke="#e8feff" stroke-width="2.2" stroke-linecap="round"/>')
    add('<circle class="pulse loop" r="4.5" fill="#e8feff" filter="url(#blur2)"/>')
    add('<circle class="pulse loop" r="2" fill="#ffffff"/>')

    # Reservoirs: real dams, approximate positions, staggered pulses.
    for i, (lon, lat) in enumerate(DAMS):
        x, y = P(lon, lat)
        add(f'<ellipse class="ring loop" cx="{x}" cy="{y}" rx="7" ry="{7 * SQUASH:.1f}" fill="none" stroke="#62e3f0" stroke-width="1.4" '
            f'style="animation-delay:{0.5 + i * 0.6:.1f}s"/>')
        add(f'<circle cx="{x}" cy="{y}" r="3" fill="#62e3f0"/><circle cx="{x}" cy="{y}" r="1.4" fill="#eaffff"/>')

    # Tozeur solar plant: a warm sun on the desert.
    add(f'<circle cx="{tx}" cy="{ty}" r="26" fill="#f7ce76" opacity=".25" filter="url(#blur6)" class="breathe"/>')
    rays = "".join(
        f'<line x1="{tx + math.cos(a) * 9:.1f}" y1="{ty + math.sin(a) * 9:.1f}" x2="{tx + math.cos(a) * 15:.1f}" y2="{ty + math.sin(a) * 15:.1f}"/>'
        for a in [k * math.pi / 6 for k in range(12)])
    add(f'<g class="rays" stroke="#f7ce76" stroke-width="1.6" stroke-linecap="round">{rays}</g>')
    add(f'<circle cx="{tx}" cy="{ty}" r="6" fill="#f7ce76"/>')
    add("</g>")  # slab

    # Wind farms: upright turbines standing on the slab.
    for k, (lon, lat) in enumerate(WIND):
        x, y = P(lon, lat)
        for j, (dx, h) in enumerate([(-9, 30), (4, 38), (16, 27)]):
            bx, by = x + dx, y + j * 2 - 2
            hx, hy = bx, by - h
            blades = "".join(
                f'<path d="M{hx},{hy} q-1.4,-6 0,-{h * 0.42:.0f} q1.4,6 0,{h * 0.42:.0f} Z" transform="rotate({a} {hx} {hy})"/>'
                for a in (0, 120, 240))
            add(f'<g class="fade2"><line x1="{bx}" y1="{by}" x2="{hx}" y2="{hy}" stroke="#eef6ef" stroke-width="1.4" stroke-linecap="round"/>'
                f'<g class="rotor" style="transform-origin:{hx}px {hy}px;animation-duration:{2.6 + j * 0.7 + k * 0.4:.1f}s" fill="#eef6ef">{blades}</g>'
                f'<circle cx="{hx}" cy="{hy}" r="1.6" fill="#eef6ef"/></g>')

    # The drop: falls on the Jendouba pilot, then ripples.
    add(f'<g class="loop"><ellipse class="splash" cx="{jx}" cy="{jy}" rx="30" ry="{30 * SQUASH:.0f}" fill="none" stroke="#b8fbff" stroke-width="1.6"/>'
        f'<ellipse class="splash" style="animation-delay:1.45s" cx="{jx}" cy="{jy}" rx="18" ry="{18 * SQUASH:.0f}" fill="none" stroke="#62e3f0" stroke-width="1.2"/>'
        f'<path class="drop" d="M{jx},{jy - 26} C{jx},{jy - 26} {jx - 8},{jy - 13} {jx - 8},{jy - 7} a8,8 0 0 0 16,0 C{jx + 8},{jy - 13} {jx},{jy - 26} {jx},{jy - 26} Z" '
        f'fill="#b8fbff"/></g>')
    add(f'<circle cx="{jx}" cy="{jy}" r="4" fill="#c9ef86"/><circle cx="{jx}" cy="{jy}" r="9" fill="none" stroke="#c9ef86" stroke-width="1" opacity=".6" class="breathe"/>')

    # Labels.
    def label(x, y, text, color, anchor="start", dx=12, dy=4):
        return (f'<text class="b fade3" x="{x + dx}" y="{y + dy}" font-size="13" font-weight="600" fill="{color}" text-anchor="{anchor}" '
                f'style="paint-order:stroke" stroke="#04100f" stroke-width="4" stroke-linejoin="round">{text}</text>')
    add(label(jx, jy, "Jendouba pilot", "#c9ef86", "start", 14, 16))
    add(label(tx, ty, "Tozeur solar", "#f7ce76", "start", 20, 5))
    wx, wy = P(*WIND[0])
    add(label(wx, wy, "Sidi Daoud wind", "#eef6ef", "start", 26, -4))
    sx, sy = P(*DAMS[0])
    add(label(sx, sy, "Sidi Salem dam", "#9ff3fb", "start", 12, -8))

    # Floating motes over everything.
    motes = []
    for _ in range(26):
        x, y = rnd.uniform(700, 1260), rnd.uniform(40, 540)
        motes.append(f'<circle class="mote" cx="{x:.0f}" cy="{y:.0f}" r="{rnd.uniform(.8, 1.8):.1f}" fill="#e8feff" opacity="{rnd.uniform(.2, .6):.2f}" '
                     f'style="animation-delay:-{rnd.uniform(0, 9):.1f}s"/>')
    add("<g>" + "".join(motes) + "</g>")

    # --------------------------------------------------------- wordmark
    add('<g>')
    add('<text class="t rise1" x="72" y="118" font-size="13" font-weight="600" letter-spacing="5" fill="#62e3f0">TUNISIA · IRRIGATION INTELLIGENCE</text>')
    add('<g class="rise2">')
    add('<text x="68" y="262" class="t" font-size="138" font-weight="700" letter-spacing="-5" fill="url(#word)">MIZUHO</text>')
    add('<g clip-path="url(#wordClip)"><rect class="shimmer loop" x="0" y="120" width="180" height="170" fill="url(#band)" transform="skewX(-18)"/></g>')
    add('</g>')
    add('<text class="b rise3" x="74" y="318" font-size="27" font-weight="500" fill="#eef6ef">Renewable-powered water intelligence</text>')
    add('<text class="b rise3" x="74" y="354" font-size="27" font-weight="500" fill="#eef6ef" opacity=".7">for Tunisian agriculture.</text>')

    chips = [("M6", "CP-SAT irrigation planning", "#62e3f0"), ("M7", "3D dashboard", "#c9ef86"), ("M8", "Evidence assistant", "#f7ce76")]
    x = 74
    add('<g class="rise4">')
    for code, text, color in chips:
        width = 54 + len(text) * 7.6
        add(f'<rect x="{x}" y="392" width="{width:.0f}" height="36" rx="18" fill="#ffffff" fill-opacity=".05" stroke="{color}" stroke-opacity=".55"/>'
            f'<circle cx="{x + 18}" cy="410" r="4" fill="{color}"/>'
            f'<text class="b" x="{x + 30}" y="415" font-size="13" fill="#eef6ef"><tspan font-weight="700" fill="{color}">{code}</tspan>  {text}</text>')
        x += width + 10
    add('</g>')
    add('<text class="t fade3" x="74" y="486" font-size="12" letter-spacing="6" fill="#eef6ef" opacity=".45">WATER · LAND · SUN</text>')
    add('</g>')

    add(f'<rect width="{W}" height="{H}" fill="url(#vignette)" pointer-events="none"/>')
    add("</svg>")
    return "\n".join(out) + "\n"


if __name__ == "__main__":
    OUT.write_text(build(), encoding="utf-8")
    print(f"wrote {OUT.relative_to(Path.cwd()) if OUT.is_relative_to(Path.cwd()) else OUT} ({OUT.stat().st_size:,} bytes)")
