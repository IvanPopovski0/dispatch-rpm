// The Rates sheet: where the reference $/mile comes from, and the controls to
// override it by hand or switch to rates a manager gave you.

import { daysOld, parseNumber, rpm, shortDate } from './calc.js';
import { api, el } from './common.js';
import { segmented, sheetIn, sheetOut } from './fx.js';

const NAMES = { van: 'Dry van', reefer: 'Reefer', flatbed: 'Flatbed' };
const SOURCE_NAMES = { dat: 'DAT weekly reports', diesel: 'U.S. diesel price (EIA)', teamfile: 'Team rates file' };
const STALE_DAYS = 14;

/** One-line, plain description of where a reference rate came from. */
export function rateSource(r, market) {
  if (!r) return '';
  const when = shortDate(r.as_of);
  const fuel = r.fuel_change ? `, ${r.fuel_change > 0 ? '+' : '−'}${Math.abs(Math.round(r.fuel_change * 100))}¢ diesel since` : '';
  switch (r.source) {
    case 'company': {
      const by = market?.company?.by ? ` by ${market.company.by}` : '';
      return `company rate${by}${when ? `, set ${when}` : ''}${market?.company?.diesel && r.fuel_change ? ' + diesel' : ''}`;
    }
    case 'manual':
      return `typed in ${when}${fuel ? `${fuel} then` : ''}`;
    case 'dat':
      return `DAT national, report of ${when}`;
    case 'teamfile':
      return `team rates file, ${when}${fuel ? `${fuel} then` : ''}`;
    default:
      return `DAT national, week of ${when}${fuel ? `${fuel} then` : ''}`;
  }
}

/** Mark rates whose underlying number is old. */
export function annotate(market) {
  for (const group of [market.active, market.auto]) {
    for (const r of Object.values(group || {})) {
      if (r) r.stale = (daysOld(r.as_of) ?? 0) > STALE_DAYS;
    }
  }
  return market;
}

function ago(ts) {
  if (!ts) return 'never';
  const mins = Math.round((Date.now() / 1000 - ts) / 60);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

export function createRatesSheet(ctx) {
  const sheet = document.getElementById('rates-sheet');
  const scrim = document.getElementById('rates-scrim');
  const $ = (sel) => sheet.querySelector(sel);
  let editing = null;   // equipment being edited by hand
  let lastFocus = null;

  const modeSeg = segmented($('#rate-mode-seg'), (mode) => {
    ctx.setSetting('rate_mode', mode);
    render();
  });

  function open() {
    lastFocus = document.activeElement;
    sheetIn(sheet, scrim);
    render();
    modeSeg.relayout();
    $('#rates-close').focus();
  }

  function close() {
    editing = null;
    sheetOut(sheet, scrim);
    lastFocus?.focus?.();
  }

  document.getElementById('rates-open').addEventListener('click', open);
  $('#rates-close').addEventListener('click', close);
  scrim.addEventListener('click', close);
  sheet.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  });

  $('#rates-check').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Checking…';
    ctx.setChecking(true);
    try {
      ctx.setMarket(await api('/api/market/refresh', { method: 'POST' }));
    } catch (err) {
      btn.textContent = err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Check now';
      ctx.setChecking(false);
    }
  });

  for (const input of sheet.querySelectorAll('[data-company]')) {
    input.addEventListener('input', () => {
      const v = input.value.trim();
      const ok = v === '' || (parseNumber(v) >= 0.5 && parseNumber(v) <= 20);
      input.classList.toggle('invalid', !ok);
      if (!ok) return;
      ctx.setSetting(`company_${input.dataset.company}`, v === '' ? '' : String(parseNumber(v)));
      ctx.setSetting('company_date', new Date().toLocaleDateString('en-CA'));
    });
  }
  $('#company-by').addEventListener('input', (e) => ctx.setSetting('company_by', e.target.value));
  $('#company-diesel').addEventListener('click', (e) => {
    const on = e.currentTarget.getAttribute('aria-checked') !== 'true';
    e.currentTarget.setAttribute('aria-checked', String(on));
    ctx.setSetting('company_diesel', on ? '1' : '0');
  });

  async function setManual(eq, value) {
    try {
      ctx.setMarket(await api('/api/market/manual', {
        method: 'POST',
        body: value === null ? { equipment: eq, clear: true } : { equipment: eq, value },
      }));
      editing = null;
    } catch (err) {
      const msg = sheet.querySelector(`[data-error="${eq}"]`);
      if (msg) msg.textContent = err.message;
    }
    render();
  }

  function rateRow(eq) {
    const r = ctx.market?.auto?.[eq];
    if (!r) return el('div', { class: 'rate-row' }, el('span', { class: 'name' }, NAMES[eq]), el('span', { class: 'value' }, '—'));
    const badge = r.source === 'manual'
      ? el('span', { class: 'badge hand' }, 'Typed in')
      : r.source === 'dat' ? el('span', { class: 'badge live' }, 'Live') : el('span', { class: 'badge' }, 'Saved');
    let detail;
    if (r.method === 'linehaul') {
      detail = `DAT linehaul ${rpm(r.linehaul)} (report ${shortDate(r.as_of)}) + fuel ${rpm(r.fuel)}`;
    } else {
      detail = `${rateSource(r, ctx.market)}`;
    }
    if (r.stale) detail += ' · may be out of date';

    const actions = el('div', { class: 'actions' });
    if (editing === eq) {
      const input = el('input', { inputmode: 'decimal', 'aria-label': `${NAMES[eq]} rate`, value: r.value.toFixed(2) });
      const save = el('button', { type: 'button', class: 'btn btn-gold btn-sm' }, 'Save');
      const cancel = el('button', { type: 'button', class: 'btn btn-ghost btn-sm' }, 'Cancel');
      const submit = () => {
        const v = parseNumber(input.value);
        if (v === null) input.classList.add('invalid');
        else setManual(eq, v);
      };
      save.addEventListener('click', submit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); editing = null; render(); }
      });
      cancel.addEventListener('click', () => { editing = null; render(); });
      actions.append(input, save, cancel, el('span', { class: 'fine', 'data-error': eq }));
      queueMicrotask(() => { input.focus(); input.select(); });
    } else {
      const edit = el('button', { type: 'button', class: 'link' }, 'Edit by hand');
      edit.addEventListener('click', () => { editing = eq; render(); });
      actions.append(edit);
      if (r.source === 'manual') {
        const back = el('button', { type: 'button', class: 'link' }, 'Use DAT again');
        back.addEventListener('click', () => setManual(eq, null));
        actions.append(el('span', { class: 'fine' }, '·'), back);
      }
    }
    return el('div', { class: 'rate-row' },
      el('span', { class: 'name' }, NAMES[eq], badge),
      el('span', { class: 'value' }, rpm(r.value)),
      el('span', { class: 'detail' }, detail),
      actions);
  }

  function render() {
    if (sheet.hidden || !ctx.market) return;
    const m = ctx.market;
    const mode = ctx.settings.rate_mode;
    modeSeg.set(mode, { animate: false });
    $('#rates-auto').hidden = mode !== 'auto';
    $('#rates-company').hidden = mode !== 'company';

    if (mode === 'auto') {
      $('#rate-list').replaceChildren(...['van', 'reefer', 'flatbed'].map(rateRow));
      $('#rate-sources').replaceChildren(...m.sources.map((s) => {
        const optional = s.key === 'teamfile' && s.ok === null;
        return el('li', {},
          el('span', { class: `dot ${s.ok === true ? 'ok' : s.ok === false ? 'bad' : ''}` }),
          el('span', {}, el('b', {}, SOURCE_NAMES[s.key] || s.key), optional ? ' · optional' : ` · checked ${ago(s.checked)}`),
          el('small', {}, optional
            ? 'Not set up. Lets you push one set of rates to every copy of the app (see README).'
            : s.message || 'Not checked yet.'));
      }));
    } else {
      for (const input of sheet.querySelectorAll('[data-company]')) {
        if (document.activeElement !== input) input.value = ctx.settings[`company_${input.dataset.company}`] || '';
      }
      const by = $('#company-by');
      if (document.activeElement !== by) by.value = ctx.settings.company_by || '';
      $('#company-diesel').setAttribute('aria-checked', String(ctx.settings.company_diesel === '1'));
      const missing = ['van', 'reefer', 'flatbed'].filter((eq) => !ctx.settings[`company_${eq}`]);
      const parts = [];
      if (ctx.settings.company_date) parts.push(`Last changed ${shortDate(ctx.settings.company_date)}.`);
      if (missing.length) parts.push(`No company rate for ${missing.map((e) => NAMES[e].toLowerCase()).join(', ')}, so the national average is used there.`);
      const now = ['van', 'reefer', 'flatbed'].map((eq) => m.active[eq] && m.active[eq].source === 'company'
        ? `${NAMES[eq]} ${rpm(m.active[eq].value)}` : null).filter(Boolean);
      if (now.length && ctx.settings.company_diesel === '1') parts.push(`With diesel today: ${now.join(' · ')}.`);
      $('#company-meta').textContent = parts.join(' ');
    }
  }

  return { open, close, render, isOpen: () => !sheet.hidden };
}
