// The LTL / partial switch and the stops between pickup and delivery, shared by
// Simple and Advanced. Stops are listed in the order the truck drives them.

import { MAX_STOPS } from './load.js';
import { el } from './common.js';

const KIND = { pickup: 'Pickup', drop: 'Drop' };

/** Wire the switch and stop list inside `root` ([data-ltl] and [data-stops]). */
export function createStopsEditor(root, ctx) {
  const toggle = root.querySelector('[data-ltl]');
  const box = root.querySelector('[data-stops]');
  const list = el('div', { class: 'stop-list' });
  const add = el('button', { type: 'button', class: 'btn btn-ghost btn-sm' }, '+ Add stop');
  box.append(list, add);
  let shape = null;  // the kinds of the rows on screen; rows are rebuilt only when this changes

  const changed = () => ctx.render();

  toggle.addEventListener('click', () => {
    const on = !ctx.load.ltl;
    ctx.load.setLtl(on);
    if (on && !ctx.load.stops.length) ctx.load.addStop('drop');
    changed();
    if (on) list.querySelector('input')?.focus();
  });
  add.addEventListener('click', () => {
    ctx.load.addStop('drop');
    changed();
    list.querySelectorAll('[data-f="zip"]')[ctx.load.stops.length - 1]?.focus();
  });
  list.addEventListener('input', (e) => {
    const { i, f } = e.target.dataset;
    if (f) {
      ctx.load.setStop(Number(i), f, e.target.value);
      changed();
    }
  });
  list.addEventListener('click', (e) => {
    const btn = e.target.closest?.('button[data-f]');
    if (!btn) return;
    const i = Number(btn.dataset.i);
    if (btn.dataset.f === 'kind') ctx.load.setStop(i, 'kind', ctx.load.stops[i].kind === 'pickup' ? 'drop' : 'pickup');
    else ctx.load.removeStop(i);
    changed();
  });

  function row(stop, i) {
    const n = i + 1;
    return el('div', { class: 'stop' },
      el('span', { class: 'stop-n' }, `Stop ${n}`),
      el('input', { 'data-i': i, 'data-f': 'zip', inputmode: 'numeric', maxlength: '10', autocomplete: 'off',
        placeholder: 'ZIP', 'aria-label': `Stop ${n} ZIP` }),
      el('button', { type: 'button', class: 'btn btn-ghost btn-sm stop-kind', 'data-i': i, 'data-f': 'kind',
        title: 'Switch between pickup and drop', 'aria-label': `Stop ${n} is a ${KIND[stop.kind].toLowerCase()}; switch` },
      KIND[stop.kind]),
      stop.kind === 'pickup'
        ? el('div', { class: 'money' }, el('span', {}, '$'), el('input', { 'data-i': i, 'data-f': 'rate',
          inputmode: 'decimal', autocomplete: 'off', placeholder: 'pays', 'aria-label': `Stop ${n} pickup pays` }))
        : el('span'),
      el('button', { type: 'button', class: 'icon-btn', 'data-i': i, 'data-f': 'remove', 'aria-label': `Remove stop ${n}` }, '✕'),
      el('p', { class: 'found' }));
  }

  return {
    render(cur) {
      toggle.setAttribute('aria-checked', String(ctx.load.ltl));
      box.hidden = !ctx.load.ltl;
      const kinds = ctx.load.stops.map((s) => s.kind).join();
      if (kinds !== shape) {
        shape = kinds;
        list.replaceChildren(...ctx.load.stops.map(row));
      }
      add.hidden = ctx.load.stops.length >= MAX_STOPS;
      [...list.children].forEach((node, i) => {
        const stop = ctx.load.stops[i];
        for (const input of node.querySelectorAll('input')) {
          if (document.activeElement !== input) input.value = stop[input.dataset.f];
        }
        const zip = node.querySelector('[data-f="zip"]');
        const bad = stop.zip.trim() !== '' && !cur.stops[i]?.zip;
        zip.classList.toggle('invalid', bad);
        const place = cur.stops[i]?.place;
        const found = node.querySelector('.found');
        found.className = `found ${bad || place?.status === 'error' ? 'error' : place?.status === 'ok' ? '' : 'dim'}`;
        found.textContent = bad ? 'A ZIP code is 5 numbers.'
          : place?.status === 'ok' ? `✓ ${place.data.name}`
            : place?.status === 'error' ? place.error
              : place?.status === 'loading' ? 'Checking…' : '';
      });
    },
  };
}
