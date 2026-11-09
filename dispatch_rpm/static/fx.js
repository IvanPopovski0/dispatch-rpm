// Motion: springy segmented controls, a calm settle when the answer changes,
// and view/sheet transitions. Nothing here animates continuously or follows
// the pointer, so nothing repaints under the glass while you work.

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

function effectsOn() {
  return !document.documentElement.classList.contains('fx-off');
}

export function setEffects(on) {
  document.documentElement.classList.toggle('fx-off', !on);
}

const motionOk = () => effectsOn() && !reduceMotion.matches;

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

/** Swap text with a short fade-up, only when it actually changed. */
export function setText(el, text) {
  if (el.textContent === text) return;
  el.textContent = text;
  if (!motionOk()) return;
  el.animate([{ transform: 'translateY(3px)', opacity: 0.4 }, { transform: 'none', opacity: 1 }],
    { duration: 240, easing: 'cubic-bezier(.2, .8, .2, 1)' });
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
