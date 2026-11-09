// App shell: loads state, owns the shared load and settings, switches between
// Simple and Advanced, and keeps the rate chip and Rates sheet in step.

import { normalizeZip, rpm } from './calc.js';
import { api, createSettingsSaver, onConnectionChange, trackWindow, watchMarket } from './common.js';
import { segmented, setEffects, swapViews } from './fx.js';
import { createAdvancedView } from './advanced.js';
import { createLoad } from './load.js';
import { annotate, createRatesSheet } from './rates.js';
import { createSimpleView } from './simple.js';

const $ = (id) => document.getElementById(id);
const RATE_KEYS = new Set(['rate_mode', 'company_van', 'company_reefer', 'company_flatbed',
  'company_by', 'company_date', 'company_diesel']);
const SHORT = { van: 'Van', reefer: 'Reefer', flatbed: 'Flatbed' };

const saver = createSettingsSaver();
let marketTimer = 0;
let checking = false;
let flashTimer = 0;

const ctx = {
  settings: {},
  quotes: [],
  market: null,
  load: createLoad(() => render()),
  flash: false,

  edit(field, value) {
    ctx.load.set(field, value);
    if (field === 'truck') {
      const zip = value.trim() === '' ? '' : normalizeZip(value);
      if (zip !== null && zip !== ctx.settings.truck_zip) ctx.setSetting('truck_zip', zip, false);
    }
    render();
  },

  setSetting(key, value, rerender = true) {
    ctx.settings[key] = value;
    saver.queue(key, value);
    if (RATE_KEYS.has(key)) {
      // The server works out company/national rates; ask again once the save has landed.
      clearTimeout(marketTimer);
      marketTimer = setTimeout(async () => {
        try { ctx.setMarket(await api('/api/market')); } catch { /* shown by the connection notice */ }
      }, 700);
    }
    if (rerender) render();
  },

  setMarket(market) {
    ctx.market = annotate(market);
    render();
    rates.render();
  },

  setChecking(on) {
    checking = on;
    renderChip();
  },

  clearLoad() {
    ctx.load.clear();
    views[ctx.settings.ui_mode].show();
    render();
    views[ctx.settings.ui_mode].focusFirst();
  },

  flashStatus(fn) {
    clearTimeout(flashTimer);
    ctx.flash = true;
    fn();
    flashTimer = setTimeout(() => { ctx.flash = false; }, 3500);
  },

  render: () => render(),
};

const views = {
  simple: createSimpleView($('view-simple'), ctx),
  advanced: createAdvancedView($('view-advanced'), ctx),
};
const sections = { simple: $('view-simple'), advanced: $('view-advanced') };
const rates = createRatesSheet(ctx);

// Truck type appears in both modes; both controls show the same choice.
const equipmentSegs = [...document.querySelectorAll('[data-equipment]')].map((root) =>
  segmented(root, (eq) => {
    ctx.setSetting('equipment', eq);
    for (const s of equipmentSegs) s.set(eq, { animate: false });
  }));

const modeSeg = segmented($('mode-seg'), (mode) => switchMode(mode));

async function switchMode(mode) {
  const from = ctx.settings.ui_mode;
  if (mode === from) return;
  ctx.setSetting('ui_mode', mode, false);
  views[mode].show();
  render();
  await swapViews(sections[from], sections[mode]);
  for (const s of equipmentSegs) s.relayout();
  views[mode].focusFirst();
}

function renderChip() {
  const eq = ctx.settings.equipment;
  const r = ctx.market?.active?.[eq];
  const label = $('rate-chip-label');
  label.replaceChildren();
  if (r) {
    const b = document.createElement('b');
    b.textContent = rpm(r.value);
    label.append(b, ` ${SHORT[eq]}${r.source === 'company' ? ' · company' : ''}`);
  } else {
    label.textContent = 'Rates';
  }
  const pulse = document.querySelector('.rate-chip .pulse');
  pulse.className = 'pulse';
  if (checking || ctx.market?.checking) pulse.classList.add('checking');
  else if (r?.source === 'company') pulse.classList.add('company');
  else if (r?.stale) pulse.classList.add('stale');
}

function render() {
  if (!ctx.settings.ui_mode) return;
  for (const s of equipmentSegs) s.set(ctx.settings.equipment, { animate: false });
  views[ctx.settings.ui_mode].render();
  renderChip();
}

function bindKeys() {
  document.addEventListener('keydown', (e) => {
    if (e.isComposing || rates.isOpen()) return;
    const view = views[ctx.settings.ui_mode];
    if (e.key === 'Escape') {
      ctx.clearLoad();
    } else if (e.key === 'Enter' && e.target.matches?.('input[data-field]')) {
      e.preventDefault();
      view.onEnter(e.target);
    }
  });
}

function bindEffects() {
  const btn = $('fx-toggle');
  const apply = () => {
    const on = ctx.settings.effects !== 'off';
    setEffects(on);
    btn.textContent = on ? 'Motion on' : 'Motion off';
  };
  btn.addEventListener('click', () => {
    ctx.setSetting('effects', ctx.settings.effects === 'off' ? 'on' : 'off', false);
    apply();
  });
  apply();
}

async function init() {
  onConnectionChange((ok) => {
    $('conn').textContent = ok ? '' : 'The app has stopped. Close this window and open Dispatch RPM again.';
  });

  let state;
  try {
    state = await api('/api/state');
  } catch (err) {
    $('conn').textContent = `${err.message}. Close this window and open Dispatch RPM again.`;
    return;
  }
  Object.assign(ctx.settings, state.settings);
  ctx.quotes.push(...state.quotes);
  ctx.market = annotate(state.market);
  $('version').textContent = `v${state.version}`;

  bindEffects();
  const mode = ctx.settings.ui_mode;
  sections.simple.hidden = mode !== 'simple';
  sections.advanced.hidden = mode !== 'advanced';
  modeSeg.set(mode, { animate: false });
  for (const s of equipmentSegs) s.set(ctx.settings.equipment, { animate: false });

  ctx.load.set('truck', ctx.settings.truck_zip || '');
  views[mode].show();
  bindKeys();
  trackWindow(saver);
  watchMarket((m) => ctx.setMarket(m));
  render();
  views[mode].focusFirst();
}

init();
