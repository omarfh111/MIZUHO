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

/** Aerial perspective: distance haze that warms when looking towards the sun. Needs uSunDir. */
const scatter = /* glsl */ `
  vec3 atmosphere(vec3 col, float dist) {
    vec3 ray = normalize(vWorld - cameraPosition);
    float sun = pow(max(dot(ray, normalize(uSunDir)), 0.), 5.);
    vec3 haze = mix(uFogColor, srgb(vec3(.98, .72, .46)) * .55, sun * .75);
    float f = 1. - exp(-pow(dist * uFogDensity, 1.7));
    return mix(col, haze, clamp(f, 0., 1.));
  }
  float cloudShadow(vec2 xz, float t) {
    float c = fbm(xz * .045 + vec2(t * .012, t * .006));
    return smoothstep(.5, .68, c);
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
  uniform float uRain;
  uniform float uCloudShadow;
  ${scatter}

  vec2 rot2(vec2 p, float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c) * p; }

  void main() {
    vec4 tex = texture2D(uLand, vUv);
    float land = smoothstep(.42, .58, tex.r);
    float shelf = texture2D(uLand, vUv, 5.5).r;
    float river = smoothstep(.15, .75, tex.b);
    vec2 ll = vec2(vWorld.x / 24. + 9.6, -vWorld.z / 24. + 34.);
    float lon = ll.x;
    float lat = ll.y;
    vec3 viewDir = normalize(cameraPosition - vWorld);
    // Detail fades out with distance so far terrain never shimmers.
    float near = 1. - smoothstep(18., 120., vViewDist);
    float close = 1. - smoothstep(4., 40., vViewDist);

    /* ---- micro-relief: noise-derivative bump ---- */
    vec2 q = vWorld.xz * 1.4;
    float e = .08;
    float h0 = fbm(q);
    float hx = fbm(q + vec2(e, 0.));
    float hz = fbm(q + vec2(0., e));
    vec3 n = normalize(vNormal + vec3(h0 - hx, 0., h0 - hz) * (2.2 * near + .6) * land);

    /* ---- biomes, north to south ---- */
    vec3 desert = srgb(vec3(.8, .62, .39));
    vec3 dune = srgb(vec3(.88, .68, .42));
    vec3 steppe = srgb(vec3(.6, .56, .38));
    vec3 tell = srgb(vec3(.36, .45, .24));
    vec3 forest = srgb(vec3(.15, .27, .14));
    vec3 olive = srgb(vec3(.47, .49, .3));
    vec3 chottCol = srgb(vec3(.9, .88, .82));
    vec3 rock = srgb(vec3(.45, .4, .33));
    float warp = fbm(ll * 3.) - .5;
    vec3 base = mix(desert, steppe, smoothstep(33.1, 34.7, lat + warp * .6));
    base = mix(base, olive, smoothstep(10.15, 10.65, lon) * smoothstep(34.3, 34.9, lat) * (1. - smoothstep(35.8, 36.3, lat)));
    base = mix(base, tell, smoothstep(35.3, 36.4, lat + warp * .3));
    base = mix(base, forest, smoothstep(36.55, 36.95, lat) * smoothstep(9.6, 9., lon));

    // Tell farmland: a warped patchwork of fields with darker hedgerows.
    float farm = smoothstep(35.15, 35.8, lat) * (1. - smoothstep(1.1, 1.7, vWorld.y)) * near;
    vec2 g = rot2(ll * 70., .35 + warp * .4) + vec2(fbm(ll * 9.) * 2.);
    vec2 cell = floor(g);
    float pick = hash12(cell);
    vec3 crop = pick < .3 ? srgb(vec3(.74, .64, .38)) : pick < .55 ? srgb(vec3(.33, .46, .2)) : pick < .8 ? srgb(vec3(.45, .35, .23)) : srgb(vec3(.56, .52, .34));
    vec2 edge = abs(fract(g) - .5);
    float hedge = smoothstep(.43, .5, max(edge.x, edge.y));
    base = mix(base, mix(crop, base * .7, hedge * .7), farm * .75);

    // Sahel olive groves: dark dotted orchards.
    float groves = smoothstep(10.15, 10.6, lon) * smoothstep(34.4, 34.9, lat) * (1. - smoothstep(35.7, 36.1, lat)) * close;
    vec2 tree = fract(ll * 900.) - .5;
    base = mix(base, base * .55, groves * smoothstep(.22, .12, length(tree)) * .8);

    // Grand Erg: wind-sculpted dune crests catching the low sun.
    float erg = (1. - smoothstep(32.9, 33.6, lat)) * (1. - smoothstep(9.4, 10.1, lon));
    float phase = dot(ll, vec2(55., 22.)) + fbm(ll * 6.) * 7.;
    n = normalize(n + vec3(cos(phase) * .35, 0., .15) * erg * near);
    base = mix(base, dune * (.88 + .12 * sin(phase)), erg * .8);

    base = mix(base, rock, clamp(smoothstep(1.4, 2.8, vWorld.y) * .55 + smoothstep(.25, .6, 1. - n.y) * .3, 0., 1.));
    float chott = pow((lon - 8.35) / .58, 2.) + pow((lat - 33.76) / .15, 2.);
    float salt = 1. - smoothstep(.75, 1.1, chott);
    float cracks = smoothstep(.04, 0., abs(vnoise(ll * 260.) - .5)) * close;
    base = mix(base, chottCol * (1. - cracks * .25), salt * (.8 + .2 * vnoise(ll * 40.)));
    base *= .92 + .16 * vnoise(ll * 140.);

    /* ---- lighting ---- */
    float diffuse = max(dot(n, uSunDir), 0.);
    float sky = .5 + .5 * n.y;
    float shadow = cloudShadow(vWorld.xz, uTime) * uCloudShadow;
    vec3 landCol = base * (srgb(vec3(.24, .33, .38)) * sky * .85 + uSunColor * diffuse * 1.45 * (1. - shadow * .55));
    // Rain-soaked north: darker soil with a sky sheen.
    float wet = uRain * smoothstep(35.2, 36.4, lat);
    landCol *= 1. - wet * .3;
    landCol += srgb(vec3(.5, .62, .66)) * pow(max(dot(reflect(-uSunDir, n), viewDir), 0.), 18.) * wet * .5;
    float contour = gridLine(vec2(vWorld.y * 7., 0.));
    landCol += uAccent * contour * .04 * smoothstep(.05, .3, vWorld.y) * (1. - smoothstep(30., 140., vViewDist));

    /* ---- sea ---- */
    vec2 flow = vWorld.xz * .35 + vec2(uTime * .04, -uTime * .025);
    float waves = fbm(flow) * .6 + fbm(flow * 2.7 - uTime * .05) * .4;
    vec3 deep = srgb(vec3(.01, .065, .085));
    vec3 shallow = srgb(vec3(.05, .3, .32));
    vec3 seaCol = mix(deep, shallow, clamp(shelf * 1.6, 0., 1.) * (.75 + .5 * waves));
    vec3 hv = normalize(uSunDir + viewDir);
    vec3 wn = normalize(vec3((waves - .5) * .5, 1., (fbm(flow + 4.) - .5) * .5));
    seaCol += uSunColor * pow(max(dot(wn, hv), 0.), 120.) * 2.2;
    seaCol += srgb(vec3(.3, .5, .55)) * pow(1. - max(dot(viewDir, vec3(0, 1, 0)), 0.), 4.) * .35;
    seaCol *= 1. - shadow * .3;
    // Surf line along the coast.
    seaCol += srgb(vec3(.8, .95, .95)) * smoothstep(.25, .48, tex.r) * (1. - land) * (.4 + .6 * waves) * .5;

    vec3 col = mix(seaCol, landCol, land);

    /* ---- cartographic overlays, kept subtle ---- */
    float graticule = gridLine(ll);
    col += uAccent * graticule * mix(.05, .015, land);
    float coast = 1. - smoothstep(0., fwidth(tex.r) * 1.6 + .002, abs(tex.r - .5));
    col += uAccent * coast * .9;
    col = mix(col, srgb(vec3(.45, .93, 1.)) * 1.9, river * .9);

    /* ---- radial reveal ---- */
    float dist = length(vWorld.xz - uRevealOrigin.xz);
    float radius = uReveal * 230.;
    float revealed = smoothstep(radius, radius - 18., dist);
    float ring = exp(-pow((dist - radius) / 1.8, 2.)) * step(.001, uReveal) * (1. - uReveal);
    float holo = smoothstep(radius, radius - 5., dist) * (1. - smoothstep(radius - 5., radius - 24., dist));
    float wire = gridLine(vWorld.xz * .5) * .8 + coast;
    vec3 dark = uFogColor * .35;
    col = mix(dark + uAccent * wire * holo * 1.6, col, revealed * (1. - holo * .7));
    col += uAccent * ring * 3.;

    gl_FragColor = vec4(atmosphere(col, vViewDist), 1.);
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
  uniform float uCloudShadow;
  ${scatter}

  void main() {
    vec2 q = vWorld.xz * 9.;
    float h0 = fbm(q);
    vec3 n = normalize(vNormal + vec3(h0 - fbm(q + vec2(.1, 0.)), 0., h0 - fbm(q + vec2(0., .1))) * 1.4 * (1. - smoothstep(2., 14., vViewDist)));
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
    float shadow = cloudShadow(vWorld.xz, uTime) * uCloudShadow;
    vec3 col = base * (srgb(vec3(.24, .33, .38)) * (.5 + .5 * n.y) + uSunColor * diffuse * 1.45 * (1. - shadow * .5));
    col += uAccent * gridLine(vec2(vWorld.y * 28., 0.)) * .025;
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
    gl_FragColor = vec4(atmosphere(col, vViewDist), alpha);
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

export const treeVertex = /* glsl */ `
  attribute float aDelay;
  attribute vec3 aColor;
  uniform float uReveal;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec3 vColor;
  varying float vLocalY;
  varying float vViewDist;
  void main() {
    float grow = smoothstep(aDelay * .75, aDelay * .75 + .25, uReveal);
    vColor = aColor;
    vLocalY = position.y;
    vec4 world = modelMatrix * instanceMatrix * vec4(position * grow, 1.);
    vWorld = world.xyz;
    vNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
    vec4 mv = viewMatrix * world;
    vViewDist = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

export const treeFragment = /* glsl */ `
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec3 vColor;
  varying float vLocalY;
  varying float vViewDist;
  vec3 srgb(vec3 c) { return pow(c, vec3(2.2)); }
  void main() {
    vec3 n = normalize(vNormal);
    // Wrapped diffuse reads as soft foliage rather than faceted plastic.
    float wrap = max((dot(n, uSunDir) + .45) / 1.45, 0.);
    float ao = smoothstep(-1., .6, vLocalY);
    vec3 col = vColor * (srgb(vec3(.22, .3, .34)) * (.55 + .45 * n.y) + uSunColor * wrap * 1.2) * (.45 + .55 * ao);
    vec3 v = normalize(cameraPosition - vWorld);
    col += vColor * uSunColor * pow(max(dot(-v, uSunDir), 0.), 4.) * .35;
    float f = 1. - exp(-pow(vViewDist * uFogDensity, 1.7));
    gl_FragColor = vec4(mix(col, uFogColor, clamp(f, 0., 1.)), 1.);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;
