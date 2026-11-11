// Look and motion: the frosted backdrop (a shader, painted once), springy
// segmented controls, rolling digits, a calm settle when the answer changes,
// and view/sheet transitions. Nothing here follows the pointer, and the
// backdrop never animates, so nothing repaints under the glass while you work.

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

function effectsOn() {
  return !document.documentElement.classList.contains('fx-off');
}

export function setEffects(on) {
  document.documentElement.classList.toggle('fx-off', !on);
}

const motionOk = () => effectsOn() && !reduceMotion.matches;

// ---------------------------------------------------------------- frosted backdrop

const BACKDROP = `
precision highp float;
uniform vec2 u_res;
uniform float u_dpr;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = m * p; a *= 0.5; }
  return v;
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = frag / u_res;                  // 0..1, y up
  float aspect = u_res.x / u_res.y;
  vec2 p = vec2(uv.x * aspect, uv.y);

  // Navy #071B2B at the heart, a shade deeper toward the floor, lifting toward teal at the top.
  vec3 col = mix(vec3(0.012, 0.055, 0.090), vec3(0.027, 0.106, 0.169), smoothstep(0.0, 0.65, uv.y));
  col = mix(col, vec3(0.045, 0.200, 0.250), smoothstep(0.55, 1.2, uv.y) * 0.7);

  // Soft pools of light, as if seen through frosted glass: large, blurry, same hue.
  vec2 q = vec2(fbm(p * 1.1 + 3.1), fbm(p * 1.1 + 7.7));
  float pools = fbm(p * 0.75 + q * 1.8);
  col += vec3(0.030, 0.150, 0.170) * smoothstep(0.40, 0.86, pools);          // teal #167D8D, diffused

  // Key light from the top left (teal into aqua), a softer teal glow bottom right.
  col += vec3(0.060, 0.230, 0.260) * exp(-2.3 * length((uv - vec2(0.16, 1.04)) * vec2(aspect * 0.75, 1.0)));
  col += vec3(0.030, 0.110, 0.125) * exp(-3.0 * length((uv - vec2(0.94, -0.06)) * vec2(aspect * 0.8, 1.0)));

  // A wide diagonal band of light caught in the glass.
  float d = uv.x * aspect * 0.5 + (1.0 - uv.y);
  col += vec3(0.045, 0.080, 0.085) * smoothstep(0.32, 0.0, abs(d - 0.78)) * 0.55;  // aqua sheen

  // Frost: an etched, slightly streaked micro-texture plus fine crystalline grain (in CSS pixels).
  vec2 cp = frag / u_dpr;
  float etch = noise(cp * vec2(0.62, 0.21) + fbm(cp * 0.018) * 7.0);
  col += (etch - 0.5) * 0.024;
  col += (hash(floor(cp * 1.1)) - 0.5) * 0.034;

  // Vignette, then dither so the gradient never bands.
  col *= 1.0 - 0.42 * pow(length((uv - vec2(0.5, 0.58)) * vec2(1.0, 1.2)), 2.0);
  col += (hash(frag + 0.37) - 0.5) * (1.6 / 255.0);
  gl_FragColor = vec4(col, 1.0);
}`;

/** Paint the frosted backdrop once, and again only when the window size changes. */
export function paintBackdrop(canvas) {
  let gl = null;
  try {
    gl = canvas.getContext('webgl', { antialias: false, alpha: false, preserveDrawingBuffer: true, powerPreference: 'low-power' });
  } catch { gl = null; }
  const fail = () => document.documentElement.classList.add('no-webgl');
  if (!gl) return fail();

  const shader = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  };
  let prog;
  try {
    prog = gl.createProgram();
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, 'attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }'));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, BACKDROP));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  } catch (err) {
    console.warn('backdrop shader unavailable:', err.message);
    return fail();
  }
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const paint = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(innerWidth * dpr));
    canvas.height = Math.max(1, Math.round(innerHeight * dpr));
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(gl.getUniformLocation(prog, 'u_res'), canvas.width, canvas.height);
    gl.uniform1f(gl.getUniformLocation(prog, 'u_dpr'), dpr);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  paint();
  document.documentElement.classList.add('webgl');
  let timer = 0;
  addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(paint, 150);
  });
}

/** Scroll edge: the toolbar turns into a denser material once content passes under it. */
export function toolbarEdge(bar) {
  let ticking = false;
  const update = () => {
    ticking = false;
    bar.classList.toggle('scrolled', scrollY > 6);
  };
  addEventListener('scroll', () => {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(update);
    }
  }, { passive: true });
  update();
}

// ---------------------------------------------------------------- segmented controls

/** Wire a segmented control; the thumb slides to the chosen button with a slight stretch. */
export function segmented(root, onChange) {
  const thumb = root.querySelector('.seg-thumb');
  const buttons = [...root.querySelectorAll('button[data-value]')];
  let value = null;

  function place(animate) {
    const btn = buttons.find((b) => b.dataset.value === value);
    if (!btn || !thumb || !btn.offsetWidth) return;
    const x = btn.offsetLeft;
    const w = btn.offsetWidth;
    const from = thumb.dataset.x !== undefined ? Number(thumb.dataset.x) : x;
    const fromW = thumb.dataset.w !== undefined ? Number(thumb.dataset.w) : w;
    thumb.style.width = `${w}px`;
    thumb.style.transform = `translateX(${x}px)`;
    thumb.dataset.x = x;
    thumb.dataset.w = w;
    if (animate && from !== x && motionOk()) {
      thumb.animate([
        { transform: `translateX(${from}px)`, width: `${fromW}px` },
        { transform: `translateX(${(from + x) / 2}px) scaleX(1.05)`, width: `${(fromW + w) / 2}px`, offset: 0.5 },
        { transform: `translateX(${x}px)`, width: `${w}px` },
      ], { duration: 380, easing: 'cubic-bezier(.3, 1.2, .5, 1)' });
    }
  }

  function set(v, { animate = true, notify = false } = {}) {
    if (!buttons.some((b) => b.dataset.value === v)) return;
    const changed = v !== value;
    value = v;
    for (const b of buttons) {
      const on = b.dataset.value === v;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    place(animate && changed);
    if (notify && changed) onChange?.(v);
  }

  buttons.forEach((b, i) => {
    b.addEventListener('click', () => set(b.dataset.value, { notify: true }));
    b.addEventListener('keydown', (e) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!step) return;
      e.preventDefault();
      const next = buttons[(i + step + buttons.length) % buttons.length];
      next.focus();
      set(next.dataset.value, { notify: true });
    });
  });
  new ResizeObserver(() => place(false)).observe(root);
  return { set, relayout: () => place(false) };
}

// ---------------------------------------------------------------- small motions

const numberIn = (s) => Number(String(s).replace(/[^0-9.]/g, '')) || 0;

/**
 * Change a value with rolling digits: only the characters that changed roll
 * in, up when the number grew, down when it shrank.
 */
export function setText(el, text) {
  const prev = el.dataset.value ?? el.textContent;
  if (prev === text) return;
  el.dataset.value = text;
  if (!motionOk() || !prev || text.length > 24) {
    el.textContent = text;
    return;
  }
  const up = numberIn(text) >= numberIn(prev);
  const before = [...prev];
  const after = [...text];
  const shift = before.length - after.length;  // numbers line up on the right
  const spoken = document.createElement('span');  // screen readers get the whole value, not single glyphs
  spoken.className = 'sr-only';
  spoken.textContent = text;
  el.replaceChildren(spoken, ...after.map((ch, i) => {
    const g = document.createElement('span');
    g.className = 'glyph';
    g.setAttribute('aria-hidden', 'true');
    g.textContent = ch;
    if (before[i + shift] !== ch) {
      g.animate([
        { transform: `translateY(${up ? 0.55 : -0.55}em)`, opacity: 0 },
        { transform: 'none', opacity: 1 },
      ], { duration: 460, delay: (after.length - i) * 16, easing: 'cubic-bezier(.3, 1.25, .5, 1)', fill: 'backwards' });
    }
    return g;
  }));
}

/** The answer settles in once when the verdict changes: a small scale and one soft light sweep. */
export function morph(el) {
  if (!motionOk()) return;
  el.animate([{ transform: 'scale(.98)', opacity: 0.6 }, { transform: 'none', opacity: 1 }],
    { duration: 320, easing: 'cubic-bezier(.25, 1.1, .45, 1)' });
  const sweep = document.createElement('span');
  sweep.className = 'sweep';
  sweep.setAttribute('aria-hidden', 'true');
  el.append(sweep);
  sweep.animate([{ transform: 'translateX(-60%)' }, { transform: 'translateX(60%)' }],
    { duration: 700, easing: 'cubic-bezier(.2, .8, .2, 1)' }).finished.finally(() => sweep.remove());
  // the verdict icon pops in with a small bounce
  el.querySelector('.v-icon')?.animate([
    { transform: 'scale(.4) rotate(-12deg)', opacity: 0 },
    { transform: 'scale(1.14) rotate(0)', opacity: 1, offset: 0.6 },
    { transform: 'scale(1)' },
  ], { duration: 560, easing: 'cubic-bezier(.3, 1.4, .5, 1)' });
}

/** Cross-fade between Simple and Advanced. */
export async function swapViews(from, to) {
  if (from === to) return;
  if (!motionOk()) {
    from.hidden = true;
    to.hidden = false;
    return;
  }
  await from.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(4px)' }],
    { duration: 120, easing: 'ease-in' }).finished.catch(() => {});
  from.hidden = true;
  to.hidden = false;
  to.animate([{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }],
    { duration: 240, easing: 'cubic-bezier(.2, .8, .2, 1)' });
}

export function sheetIn(sheet, scrim) {
  scrim.hidden = false;
  sheet.hidden = false;
  if (!motionOk()) return;
  scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
  sheet.animate([{ transform: 'translateX(28px)', opacity: 0 }, { transform: 'none', opacity: 1 }],
    { duration: 300, easing: 'cubic-bezier(.25, 1.1, .45, 1)' });
}

export async function sheetOut(sheet, scrim) {
  if (motionOk()) {
    scrim.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150 });
    await sheet.animate([{ transform: 'none', opacity: 1 }, { transform: 'translateX(20px)', opacity: 0 }],
      { duration: 150, easing: 'ease-in' }).finished.catch(() => {});
  }
  sheet.hidden = true;
  scrim.hidden = true;
}
