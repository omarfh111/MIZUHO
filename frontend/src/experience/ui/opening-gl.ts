/**
 * The opening's particle field, in raw WebGL2 so it starts before the 3D
 * chunk arrives. Every particle's position is a pure function of time and a
 * few uniforms (no simulation state), so it costs one draw call per frame.
 *
 *  - mist:      particles swirl in a slow vortex with curling turbulence
 *  - condense:  driven by real loading progress, each particle flies to its
 *               home pixel in the rasterised wordmark, staggered left → right
 *  - release:   the wordmark spirals into a single drop, then flashes out
 */

const VERT = /* glsl */ `#version 300 es
precision highp float;
in vec2 aSeed;      // random position in [-1, 1]^2
in vec2 aHome;      // home pixel in the wordmark, in clip-ish units
in vec4 aRand;      // x: size, y: phase, z: stagger, w: hue

uniform float uTime;
uniform float uCondense;  // 0 → 1
uniform float uRelease;   // 0 → 1
uniform float uAspect;
uniform float uScale;     // pixel ratio * base size
uniform vec2 uPointer;
uniform float uPointerOn;
uniform vec2 uDrop;       // where the drop forms, clip space
uniform float uHasHome;

out float vAlpha;
out float vHot;
out float vHue;

vec2 rot(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }

void main() {
  float t = uTime;
  // Mist: a slow vortex whose angular speed falls off with radius, plus turbulence.
  // Units: y spans [-1, 1], x spans [-aspect, aspect].
  vec2 p = aSeed * vec2(uAspect * 1.08, 1.0);
  float r = length(p);
  p = rot(p, t * (0.06 + 0.12 / (0.35 + r)) + aRand.y * 0.4);
  p += 0.06 * vec2(sin(t * 0.7 + aRand.y * 6.28 + p.y * 3.0), cos(t * 0.6 + aRand.y * 4.0 + p.x * 3.0));
  p += 0.025 * vec2(sin(t * 1.9 + p.y * 9.0), cos(t * 1.7 + p.x * 9.0));

  // Condense towards the wordmark, staggered left to right with a soft overshoot.
  float local = clamp((uCondense * 1.35 - aRand.z * 0.35) , 0.0, 1.0) * uHasHome;
  float k = 1.0 - pow(1.0 - local, 3.0);
  vec2 home = aHome + 0.004 * vec2(sin(t * 2.3 + aRand.y * 9.0), cos(t * 2.1 + aRand.y * 7.0));
  vec2 q = mix(p, home, k);
  // In flight, particles arc rather than travel in straight lines.
  q += vec2(-(home.y - p.y), home.x - p.x) * 0.35 * k * (1.0 - k);

  // Pointer: a soft fluid push.
  vec2 d = q - uPointer;
  float push = uPointerOn * 0.07 * exp(-dot(d, d) * 22.0);
  q += normalize(d + 1e-4) * push;

  // Release: spiral into the drop.
  float rel = clamp(uRelease * 1.25 - aRand.z * 0.25, 0.0, 1.0);
  float e = rel * rel * (3.0 - 2.0 * rel);
  vec2 toDrop = q - uDrop;
  q = uDrop + rot(toDrop, e * 3.2) * (1.0 - e);

  gl_Position = vec4(q.x / uAspect, q.y, 0.0, 1.0);
  float settled = k;
  gl_PointSize = uScale * (0.6 + aRand.x * 1.6) * mix(1.6, 1.0, settled) * (1.0 - e * 0.6);
  vAlpha = mix(0.22 + 0.3 * aRand.x, 0.9, settled) * (1.0 - smoothstep(0.85, 1.0, rel));
  // A caustic light sweep crosses the letters once they have formed.
  float sweep = exp(-pow((home.x - (fract(t * 0.28) * 3.2 - 1.6)) * 5.0, 2.0)) * settled;
  vHot = sweep + e * 0.8;
  vHue = aRand.w;
}`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;
in float vAlpha;
in float vHot;
in float vHue;
out vec4 color;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c) * 4.0;
  float a = exp(-d * 3.5) * vAlpha;
  vec3 deep = vec3(0.04, 0.42, 0.5);
  vec3 cyan = vec3(0.38, 0.89, 0.94);
  vec3 leaf = vec3(0.79, 0.94, 0.53);
  vec3 col = mix(deep, cyan, 0.4 + 0.6 * vHue);
  col = mix(col, leaf, smoothstep(0.86, 1.0, vHue) * 0.6);
  col += vec3(0.9, 1.0, 1.0) * vHot;
  color = vec4(col * a, a);
}`;

export interface OpeningField {
  setHomes: (text: string, font: string) => void;
  frame: (state: { time: number; condense: number; release: number; pointer: [number, number] | null; drop: [number, number] }) => void;
  resize: () => void;
  dispose: () => void;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || (gl.isContextLost() ? 'context lost' : 'shader compile failed'));
  return shader;
}

export function createOpeningField(canvas: HTMLCanvasElement, count: number): OpeningField | null {
  const gl = canvas.getContext('webgl2', { alpha: true, antialias: false, premultipliedAlpha: true, powerPreference: 'high-performance' });
  if (!gl || gl.isContextLost()) return null;
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'link failed');

  const seeds = new Float32Array(count * 2);
  const homes = new Float32Array(count * 2);
  const rands = new Float32Array(count * 4);
  let s = 20261121;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < count; i++) {
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(rnd()) * 1.15;
    seeds[i * 2] = Math.cos(a) * r;
    seeds[i * 2 + 1] = Math.sin(a) * r * 0.9;
    rands.set([rnd() ** 2, rnd(), rnd(), rnd()], i * 4);
  }

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buffer = (data: Float32Array, name: string, size: number, usage: number = gl.STATIC_DRAW) => {
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, usage);
    const loc = gl.getAttribLocation(program, name);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    return b;
  };
  buffer(seeds, 'aSeed', 2);
  const homeBuffer = buffer(homes, 'aHome', 2, gl.DYNAMIC_DRAW);
  const randBuffer = buffer(rands, 'aRand', 4);

  const u = (name: string) => gl.getUniformLocation(program, name);
  const U = {
    time: u('uTime'), condense: u('uCondense'), release: u('uRelease'), aspect: u('uAspect'), scale: u('uScale'),
    pointer: u('uPointer'), pointerOn: u('uPointerOn'), drop: u('uDrop'), hasHome: u('uHasHome'),
  };
  let hasHome = 0;
  let dpr = 1;

  const resize = () => {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
  };

  /** Rasterises the wordmark and assigns every particle a pixel inside a glyph. */
  const setHomes = (text: string, font: string) => {
    const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    const W = 900;
    const H = 260;
    const off = document.createElement('canvas');
    off.width = W;
    off.height = H;
    const ctx = off.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let size = 210;
    ctx.font = `600 ${size}px ${font}`;
    while (ctx.measureText(text).width > W * 0.94 && size > 40) {
      size -= 6;
      ctx.font = `600 ${size}px ${font}`;
    }
    ctx.fillText(text, W / 2, H / 2 + size * 0.04);
    const data = ctx.getImageData(0, 0, W, H).data;
    const inside: number[] = [];
    for (let y = 0; y < H; y += 2) {
      for (let x = 0; x < W; x += 2) if (data[(y * W + x) * 4 + 3] > 128) inside.push(x, y);
    }
    if (!inside.length) return;
    // Wordmark width in screen-height units: generous on desktop, near full width on phones.
    const span = Math.min(2.5, aspect * 2 * 0.86);
    const sx = span / W;
    for (let i = 0; i < count; i++) {
      const j = Math.floor(rnd() * (inside.length / 2)) * 2;
      const px = inside[j] + rnd() * 2;
      const py = inside[j + 1] + rnd() * 2;
      homes[i * 2] = (px - W / 2) * sx;
      homes[i * 2 + 1] = -(py - H / 2) * sx + 0.08;
      // Stagger follows the reading direction.
      rands[i * 4 + 2] = Math.min(1, Math.max(0, px / W + (rnd() - 0.5) * 0.12));
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, homeBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, homes);
    gl.bindBuffer(gl.ARRAY_BUFFER, randBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, rands);
    hasHome = 1;
  };

  const frame: OpeningField['frame'] = ({ time, condense, release, pointer, drop }) => {
    const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);
    gl.bindVertexArray(vao);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.uniform1f(U.time, time);
    gl.uniform1f(U.condense, condense);
    gl.uniform1f(U.release, release);
    gl.uniform1f(U.aspect, aspect);
    gl.uniform1f(U.scale, dpr * Math.max(2.2, Math.min(4.2, canvas.clientWidth / 420)));
    gl.uniform2f(U.pointer, pointer?.[0] ?? 9, pointer?.[1] ?? 9);
    gl.uniform1f(U.pointerOn, pointer ? 1 : 0);
    gl.uniform2f(U.drop, drop[0], drop[1]);
    gl.uniform1f(U.hasHome, hasHome);
    gl.drawArrays(gl.POINTS, 0, count);
  };

  resize();
  return {
    setHomes,
    frame,
    resize,
    // Free GPU objects but keep the context alive: a remount (StrictMode, replay)
    // asks the same canvas for its context again and must not receive a lost one.
    dispose: () => {
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
    },
  };
}
