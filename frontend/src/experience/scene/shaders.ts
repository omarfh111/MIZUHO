/* GLSL sources. Colours are authored in sRGB and linearised in-shader. */

const common = /* glsl */ `
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  vec3 srgb(vec3 c) { return pow(c, vec3(2.2)); }
  float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  float vnoise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3. - 2. * f);
    return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm(vec2 p) { float s = 0.; float a = .5; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= .5; } return s; }
  float gridLine(vec2 coord) { vec2 g = abs(fract(coord - .5) - .5) / fwidth(coord); return 1. - min(min(g.x, g.y), 1.); }
  vec3 applyFog(vec3 col, float dist) { float f = 1. - exp(-pow(dist * uFogDensity, 2.)); return mix(col, uFogColor, clamp(f, 0., 1.)); }
`;

const standardVertex = /* glsl */ `
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec2 vUv;
  varying float vViewDist;
`;

export const mapVertex = /* glsl */ `
  ${standardVertex}
  uniform vec3 uValleyCenter;
  uniform float uValleyRadius;
  uniform float uValley;
  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.);
    float inside = 1. - smoothstep(uValleyRadius * .62, uValleyRadius * .9, length(world.xz - uValleyCenter.xz));
    world.y -= inside * .45 * smoothstep(0., .12, uValley);
    vWorld = world.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    vec4 mv = viewMatrix * world;
    vViewDist = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

export const mapFragment = /* glsl */ `
  ${standardVertex}
  ${common}
  uniform sampler2D uLand;
  uniform float uTime;
  uniform float uReveal;
  uniform vec3 uRevealOrigin;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uAccent;

  void main() {
    vec4 tex = texture2D(uLand, vUv);
    float land = smoothstep(.42, .58, tex.r);
    float shelf = texture2D(uLand, vUv, 5.5).r;
    float river = smoothstep(.15, .75, tex.b);
    float lon = vWorld.x / 24. + 9.6;
    float lat = -vWorld.z / 24. + 34.;
    vec3 n = normalize(vNormal);
    vec3 viewDir = normalize(cameraPosition - vWorld);

    /* ---- land biomes, north → south ---- */
    vec3 desert = srgb(vec3(.78, .6, .36));
    vec3 steppe = srgb(vec3(.55, .53, .35));
    vec3 tell = srgb(vec3(.31, .42, .22));
    vec3 forest = srgb(vec3(.17, .29, .16));
    vec3 olive = srgb(vec3(.43, .47, .27));
    vec3 chottCol = srgb(vec3(.86, .84, .77));
    vec3 rock = srgb(vec3(.42, .38, .31));
    float mosaic = vnoise(vec2(lon, lat) * 95.);
    vec3 base = mix(desert, steppe, smoothstep(33.1, 34.7, lat + (fbm(vec2(lon, lat) * 3.) - .5) * .6));
    base = mix(base, olive, smoothstep(10.2, 10.7, lon) * smoothstep(34.3, 34.9, lat) * (1. - smoothstep(35.8, 36.3, lat)));
    base = mix(base, tell, smoothstep(35.3, 36.4, lat));
    base = mix(base, forest, smoothstep(36.55, 36.95, lat) * smoothstep(9.6, 9., lon));
    base *= .9 + .2 * mosaic * smoothstep(34.8, 36., lat);
    base = mix(base, rock, smoothstep(1.4, 2.8, vWorld.y) * .6);
    float chott = pow((lon - 8.35) / .58, 2.) + pow((lat - 33.76) / .15, 2.);
    base = mix(base, chottCol, (1. - smoothstep(.75, 1.1, chott)) * (.75 + .25 * vnoise(vec2(lon, lat) * 40.)));

    float diffuse = max(dot(n, uSunDir), 0.);
    float sky = .5 + .5 * n.y;
    vec3 landCol = base * (srgb(vec3(.2, .3, .32)) * sky * .9 + uSunColor * diffuse * 1.25);
    float contour = gridLine(vec2(vWorld.y * 7., 0.));
    landCol += uAccent * contour * .06 * smoothstep(.05, .3, vWorld.y) * (1. - smoothstep(30., 140., vViewDist));

    /* ---- sea ---- */
    vec2 flow = vWorld.xz * .35 + vec2(uTime * .04, -uTime * .025);
    float waves = fbm(flow) * .6 + fbm(flow * 2.7 - uTime * .05) * .4;
    vec3 deep = srgb(vec3(.012, .07, .085));
    vec3 shallow = srgb(vec3(.05, .27, .29));
    vec3 seaCol = mix(deep, shallow, clamp(shelf * 1.6, 0., 1.) * (.75 + .5 * waves));
    vec3 h = normalize(uSunDir + viewDir);
    vec3 wn = normalize(vec3((waves - .5) * .5, 1., (fbm(flow + 4.) - .5) * .5));
    seaCol += uSunColor * pow(max(dot(wn, h), 0.), 90.) * 1.6;
    seaCol += srgb(vec3(.2, .45, .5)) * pow(1. - max(dot(viewDir, vec3(0, 1, 0)), 0.), 4.) * .25;

    vec3 col = mix(seaCol, landCol, land);

    /* ---- cartographic overlays ---- */
    float graticule = gridLine(vec2(lon, lat));
    col += uAccent * graticule * mix(.07, .025, land);
    float coast = 1. - smoothstep(0., fwidth(tex.r) * 1.6 + .002, abs(tex.r - .5));
    col += uAccent * coast * 1.4;
    col = mix(col, srgb(vec3(.45, .93, 1.)) * 1.9, river * .9);

    /* ---- radial reveal from the first frame's focus ---- */
    float dist = length(vWorld.xz - uRevealOrigin.xz);
    float radius = uReveal * 230.;
    float revealed = smoothstep(radius, radius - 18., dist);
    float ring = exp(-pow((dist - radius) / 1.8, 2.)) * step(.001, uReveal) * (1. - uReveal);
    float holo = smoothstep(radius, radius - 5., dist) * (1. - smoothstep(radius - 5., radius - 24., dist));
    float wire = gridLine(vWorld.xz * .5) * .8 + coast;
    vec3 dark = uFogColor * .35;
    col = mix(dark + uAccent * wire * holo * 1.6, col, revealed * (1. - holo * .7));
    col += uAccent * ring * 3.;

    gl_FragColor = vec4(applyFog(col, vViewDist), 1.);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export const valleyVertex = /* glsl */ `
  ${standardVertex}
  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.);
    vWorld = world.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    vec4 mv = viewMatrix * world;
    vViewDist = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

export const valleyFragment = /* glsl */ `
  ${standardVertex}
  ${common}
  uniform float uTime;
  uniform float uReveal;
  uniform float uPresence;
  uniform vec3 uOrigin;
  uniform vec3 uCenter;
  uniform float uRadius;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uAccent;
  uniform float uTwin;
  uniform vec3 uWet;
  uniform float uWetAmount;

  void main() {
    vec3 n = normalize(vNormal);
    float slope = 1. - n.y;
    float moisture = fbm(vWorld.xz * 1.3);
    vec3 soil = srgb(vec3(.36, .3, .2));
    vec3 grass = srgb(vec3(.3, .41, .2));
    vec3 scrub = srgb(vec3(.24, .3, .17));
    vec3 base = mix(soil, grass, smoothstep(.35, .7, moisture));
    base = mix(base, scrub, smoothstep(.08, .25, slope) * .7);
    base *= .85 + .3 * vnoise(vWorld.xz * 26.);
    // Pointer "irrigation lamp": soil darkens and greens where the visitor waters it.
    float wd = length(vWorld.xz - uWet.xz) + (vnoise(vWorld.xz * 9. + uTime * .2) - .5) * .12;
    float wet = (1. - smoothstep(.12, .62, wd)) * uWetAmount;
    base = mix(base, base * srgb(vec3(.55, .78, .5)), wet);
    float diffuse = max(dot(n, uSunDir), 0.);
    vec3 col = base * (srgb(vec3(.2, .3, .32)) * (.5 + .5 * n.y) + uSunColor * diffuse * 1.3);
    col += uAccent * gridLine(vec2(vWorld.y * 28., 0.)) * .035;
    col += srgb(vec3(.4, .85, .9)) * wet * pow(max(dot(reflect(-uSunDir, n), normalize(cameraPosition - vWorld)), 0.), 24.) * .8;
    col += uAccent * exp(-pow((wd - .6) / .02, 2.)) * uWetAmount * .7;
    // Digital twin: the finale overlays a measured grid and contour lines.
    col += uAccent * (gridLine(vWorld.xz * 3.) * .45 + gridLine(vec2(vWorld.y * 40., 0.)) * .35) * uTwin;

    float d = length(vWorld.xz - uOrigin.xz);
    float radius = uReveal * uRadius * 2.4;
    float revealed = smoothstep(radius, radius - .7, d);
    float ring = exp(-pow((d - radius) / .07, 2.)) * step(.001, uReveal) * (1. - uReveal * uReveal);
    vec3 holo = uFogColor * .4 + uAccent * (gridLine(vWorld.xz * 6.) * .55 + .04);
    col = mix(holo, col, revealed) + uAccent * ring * 2.6;

    float rim = 1. - smoothstep(uRadius * .72, uRadius * .98, length(vWorld.xz - uCenter.xz));
    float alpha = rim * mix(uPresence, 1., revealed);
    if (alpha < .002) discard;
    gl_FragColor = vec4(applyFog(col, vViewDist), alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export const waterVertex = /* glsl */ `
  ${standardVertex}
  uniform float uReveal;
  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.);
    world.y -= (1. - uReveal) * .06;
    vWorld = world.xyz;
    vNormal = vec3(0., 1., 0.);
    vec4 mv = viewMatrix * world;
    vViewDist = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

export const waterFragment = /* glsl */ `
  ${standardVertex}
  ${common}
  uniform float uTime;
  uniform float uReveal;
  uniform float uExtent;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uSkyColor;

  void main() {
    #ifdef RIVER
      float edge = 1. - abs(vUv.y * 2. - 1.);
      float depth = smoothstep(0., .8, edge);
      float fill = uReveal;
      vec2 p = vec2(vUv.x * 3. - uTime * .35, vUv.y * 2.);
    #else
      float r = length(vUv / vec2(1.15, .85)) / uExtent;
      float depth = 1. - smoothstep(.25, 1.05, r);
      float fill = smoothstep(uReveal * 1.25, uReveal * 1.25 - .2, r);
      float edge = 1. - smoothstep(.85, 1.15, r);
      vec2 p = vWorld.xz * 5.;
    #endif
    float w1 = fbm(p + vec2(uTime * .22, uTime * .13));
    float w2 = fbm(p * 1.9 - vec2(uTime * .17, -uTime * .09));
    vec3 n = normalize(vec3((w1 - .5) * .9, 1., (w2 - .5) * .9));
    vec3 viewDir = normalize(cameraPosition - vWorld);
    float fresnel = pow(1. - max(dot(n, viewDir), 0.), 4.);
    vec3 deep = srgb(vec3(.015, .14, .18));
    vec3 shallow = srgb(vec3(.07, .43, .45));
    vec3 col = mix(shallow, deep, depth);
    col = mix(col, uSkyColor, fresnel * .7);
    vec3 h = normalize(uSunDir + viewDir);
    col += uSunColor * pow(max(dot(n, h), 0.), 160.) * 4.;
    col += srgb(vec3(.55, .95, 1.)) * pow(1. - depth, 6.) * .5;
    float alpha = fill * (.55 + .45 * depth) * clamp(edge * 1.5, 0., 1.);
    if (alpha < .002) discard;
    gl_FragColor = vec4(applyFog(col, vViewDist), alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export const canalVertex = /* glsl */ `
  attribute float aFlow;
  attribute float aDistance;
  varying float vFlow;
  varying float vDistance;
  varying float vViewDist;
  void main() {
    vFlow = aFlow;
    vDistance = aDistance;
    vec4 mv = modelViewMatrix * vec4(position, 1.);
    vViewDist = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

export const canalFragment = /* glsl */ `
  ${common}
  uniform float uFlow;
  uniform float uTime;
  uniform vec3 uColor;
  varying float vFlow;
  varying float vDistance;
  varying float vViewDist;
  void main() {
    float visible = smoothstep(vFlow, vFlow + .035, uFlow);
    if (visible < .002) discard;
    float pulse = pow(fract(vDistance * 2.2 - uTime * .85), 8.);
    float front = exp(-pow((uFlow - vFlow - .02) / .025, 2.)) * step(uFlow, .999);
    vec3 col = uColor * (.55 + pulse * 2.4 + front * 4.);
    gl_FragColor = vec4(applyFog(col, vViewDist), visible);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const instancedHeader = /* glsl */ `
  uniform float uReveal;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec3 vLocal;
  varying float vGrow;
  varying float vViewDist;
`;

export const plotVertex = /* glsl */ `
  ${instancedHeader}
  attribute float aDelay;
  attribute vec3 aColor;
  varying vec3 vColor;
  void main() {
    float grow = smoothstep(aDelay * .72, aDelay * .72 + .28, uReveal);
    vGrow = grow;
    vColor = aColor;
    vLocal = position;
    vec3 p = position;
    p.y *= grow;
    p.xz *= .7 + .3 * grow;
    vec4 world = modelMatrix * instanceMatrix * vec4(p, 1.);
    vWorld = world.xyz;
    vNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
    vec4 mv = viewMatrix * world;
    vViewDist = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

export const plotFragment = /* glsl */ `
  ${instancedHeader}
  ${common}
  uniform float uTime;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uAccent;
  varying vec3 vColor;
  void main() {
    if (vGrow < .002) discard;
    vec3 n = normalize(vNormal);
    float top = step(.5, n.y);
    float rows = .86 + .14 * sin(vLocal.x * 170.);
    vec2 m = abs(vLocal.xz) * 2.;
    float margin = smoothstep(.86, .96, max(m.x, m.y));
    vec3 base = mix(vColor * mix(1., rows, top), srgb(vec3(.62, .55, .4)), margin * top * .6);
    base *= mix(.55, 1., top);
    float diffuse = max(dot(n, uSunDir), 0.);
    vec3 col = base * (srgb(vec3(.22, .3, .32)) * .9 + uSunColor * diffuse * 1.25);
    float flash = vGrow * (1. - vGrow) * 4.;
    col += uAccent * flash * 1.6;
    gl_FragColor = vec4(applyFog(col, vViewDist), 1.);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export const panelVertex = /* glsl */ `
  ${instancedHeader}
  attribute float aDelay;
  void main() {
    float grow = smoothstep(aDelay * .6, aDelay * .6 + .4, uReveal);
    vGrow = grow;
    vLocal = position;
    vec4 world = modelMatrix * instanceMatrix * vec4(position * grow, 1.);
    vWorld = world.xyz;
    vNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
    vec4 mv = viewMatrix * world;
    vViewDist = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

export const panelFragment = /* glsl */ `
  ${instancedHeader}
  ${common}
  uniform float uTime;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uSkyColor;
  void main() {
    if (vGrow < .002) discard;
    vec3 n = normalize(vNormal);
    float top = step(.5, n.y);
    vec2 cell = abs(fract(vLocal.xz * vec2(6., 10.)) - .5);
    float lines = smoothstep(.44, .5, max(cell.x, cell.y));
    vec2 m = abs(vLocal.xz) * 2.;
    float frame = smoothstep(.88, .95, max(m.x, m.y));
    vec3 cellCol = srgb(vec3(.08, .16, .27));
    vec3 col = mix(cellCol, srgb(vec3(.45, .55, .62)), max(lines * .35, frame) * top);
    vec3 viewDir = normalize(cameraPosition - vWorld);
    float fresnel = pow(1. - max(dot(n, viewDir), 0.), 3.);
    col = mix(col, uSkyColor, fresnel * .6 * top);
    vec3 h = normalize(uSunDir + viewDir);
    col += uSunColor * pow(max(dot(n, h), 0.), 70.) * 1.4 * top;
    float lane = mod(vWorld.x * .8 + vWorld.z * .4 + 400., 8.);
    float sweep = exp(-pow((lane - mod(uTime * .9, 8.)) / .05, 2.));
    col += srgb(vec3(.65, .9, 1.)) * sweep * 1.6 * top;
    col *= mix(.35, 1., top);
    gl_FragColor = vec4(applyFog(col, vViewDist), 1.);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export const skyVertex = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.);
    gl_Position = p.xyww;
  }
`;

export const skyFragment = /* glsl */ `
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uGlow;
  uniform vec3 uSunDir;
  varying vec3 vDir;
  void main() {
    vec3 d = normalize(vDir);
    float h = clamp(d.y, -1., 1.);
    vec3 col = mix(uHorizon, uZenith, pow(smoothstep(-.02, .55, h), .7));
    float sun = max(dot(d, normalize(uSunDir)), 0.);
    col += uGlow * (pow(sun, 8.) * .55 + pow(sun, 120.) * 1.2) * smoothstep(-.1, .1, h);
    col += uGlow * .12 * exp(-abs(h) * 14.);
    gl_FragColor = vec4(col, 1.);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export const particleVertex = /* glsl */ `
  attribute float aSeed;
  uniform float uTime;
  uniform float uSize;
  uniform float uPixelRatio;
  uniform vec3 uBoxMin;
  uniform vec3 uBoxSize;
  varying float vTwinkle;
  varying float vSeed;
  void main() {
    vec3 p = position;
    p.y = uBoxMin.y + mod(p.y - uBoxMin.y + uTime * (.04 + aSeed * .08) * uBoxSize.y * .05, uBoxSize.y);
    p.x += sin(uTime * .3 + aSeed * 40.) * uBoxSize.x * .004;
    p.z += cos(uTime * .25 + aSeed * 30.) * uBoxSize.z * .004;
    vec4 mv = modelViewMatrix * vec4(p, 1.);
    vTwinkle = .55 + .45 * sin(uTime * (1. + aSeed * 2.) + aSeed * 60.);
    vSeed = aSeed;
    gl_PointSize = uSize * uPixelRatio * (.5 + aSeed) / max(-mv.z, .05);
    gl_Position = projectionMatrix * mv;
  }
`;

export const particleFragment = /* glsl */ `
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform float uOpacity;
  varying float vTwinkle;
  varying float vSeed;
  void main() {
    float d = length(gl_PointCoord - .5);
    float a = smoothstep(.5, .0, d);
    a *= a;
    vec3 col = mix(uColorA, uColorB, step(.7, vSeed));
    gl_FragColor = vec4(col * 1.6, a * vTwinkle * uOpacity);
  }
`;

export const cloudVertex = /* glsl */ `
  varying vec2 vUv;
  varying float vViewDist;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.);
    vViewDist = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

export const cloudFragment = /* glsl */ `
  ${common}
  uniform float uTime;
  uniform float uSeed;
  uniform float uOpacity;
  uniform vec3 uLit;
  uniform vec3 uShade;
  varying vec2 vUv;
  varying float vViewDist;
  void main() {
    vec2 p = (vUv - .5) * 2.;
    float falloff = 1. - smoothstep(.2, 1., length(p));
    float density = fbm(vUv * 3.2 + uSeed + uTime * .015);
    density = smoothstep(.38, .75, density * (.6 + .6 * fbm(vUv * 7. - uSeed))) * falloff;
    float near = smoothstep(1.5, 9., vViewDist);
    float a = density * uOpacity * near * .85;
    if (a < .002) discard;
    vec3 col = mix(uShade, uLit, smoothstep(.0, 1., vUv.y * .6 + density * .6));
    gl_FragColor = vec4(col, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export const beaconVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.);
  }
`;

export const beaconFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uTime;
  varying vec2 vUv;
  void main() {
    float fade = pow(1. - vUv.y, 2.2);
    float scan = .7 + .3 * sin(vUv.y * 40. - uTime * 6.);
    gl_FragColor = vec4(uColor * 2.2, fade * scan * uOpacity * .7);
  }
`;
