// Advanced mode: every number, your own targets, saved quotes and averages.

import {
  averageRpm, driveTime, evaluate, implausibleOffer, laneKey, money, normalizeZip, parseNumber, periodAverages, rpm,
} from './calc.js';
import { api, el } from './common.js';
import { morph } from './fx.js';
import { rateSource } from './rates.js';
import { syncTiles } from './simple.js';

const EQUIPMENT_NAMES = { van: 'Dry van', reefer: 'Reefer', flatbed: 'Flatbed' };
const NUMERIC_SETTINGS = ['target', 'floor', 'speed'];
const MAX_HISTORY_ROWS = 300;
const ICONS = { book: '✓', negotiate: '↑', drop: '✕', check: '!' };


export function createAdvancedView(root, ctx) {
  const $ = (sel) => root.querySelector(sel);
  const inputs = Object.fromEntries(
    ['truck', 'pickup', 'dropoff', 'loaded', 'deadhead', 'rate'].map((f) => [f, $(`[data-field="${f}"]`)]));
  const verdict = $('#a-verdict');
  let lastVerdict = null;
  let saving = false;

  for (const [field, input] of Object.entries(inputs)) {
    input.addEventListener('input', () => ctx.edit(field, input.value));
  }
  for (const input of root.querySelectorAll('[data-setting]')) {
    input.addEventListener('input', () => ctx.setSetting(input.dataset.setting, input.value));
  }
  $('#a-save').addEventListener('click', save);
  $('#a-clear').addEventListener('click', () => ctx.clearLoad());

  const tile = (value, label, cls = 'tile') => el('div', { class: cls }, el('b', {}, value), el('span', {}, label));
  const miles = (n) => `${Math.round(n).toLocaleString('en-US')} mi`;

  function setStatus(text, kind = '') {
    const s = $('#a-status');
    s.textContent = text;
    s.className = `status ${kind}`;
  }

  // ------------------------------------------------------------ inputs

  function renderInputs(cur) {
    const bad = (input, ok) => input.classList.toggle('invalid', input.value.trim() !== '' && !ok);
    for (const f of ['truck', 'pickup', 'dropoff']) bad(inputs[f], normalizeZip(inputs[f].value));
    for (const f of ['loaded', 'deadhead', 'rate']) bad(inputs[f], parseNumber(inputs[f].value) !== null);
    for (const key of NUMERIC_SETTINGS) {
      const input = root.querySelector(`[data-setting="${key}"]`);
      bad(input, parseNumber(input.value) !== null);
    }
    inputs.loaded.placeholder = cur.loadedAuto !== null ? `${cur.loadedAuto} (auto)` : 'auto';
    inputs.deadhead.placeholder = ctx.load.empty.key
      ? (cur.deadheadAuto !== null ? `${cur.deadheadAuto} (auto)` : '…')
      : '0';

    const link = $('#a-gmaps');
    const { pickup, dropoff } = cur.zips;
    link.hidden = !(pickup && dropoff);
    if (pickup && dropoff) {
      link.href = `https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=${pickup}%2C%20USA&destination=${dropoff}%2C%20USA`;
    }
  }

  function renderStatus(cur) {
    if (ctx.flash) return; // a save message is showing
    const { load } = ctx;
    if (!cur.zips.pickup || !cur.zips.dropoff) return setStatus('');
    if (cur.tripError) return setStatus(`${cur.tripError}. Type the miles in.`, 'error');
    if (load.trip.state.status === 'loading') return setStatus('Looking up miles…');
    const r = cur.route;
    if (!r) return setStatus('');
    let text = `${r.pickup} → ${r.dropoff}: ${miles(r.miles)}`;
    if (cur.loadedTyped) text += ` (using your ${miles(cur.loaded ?? 0)})`;
    if (load.empty.key && load.empty.state.status === 'ok') {
      text += ` · truck to pickup ${miles(load.empty.state.data.miles)}`;
    }
    if (cur.estimated) return setStatus(`${text}. ESTIMATE, the route server is busy, so double-check.`, 'warn');
    if (cur.emptyError) return setStatus(`${text}. Couldn't get empty miles: ${cur.emptyError}`, 'warn');
    setStatus(text);
  }

  // ------------------------------------------------------------ verdict

  function show(kind, title, ...lines) {
    verdict.className = `verdict glass ${kind}`;
    const heading = kind ? el('h2', {}, el('span', { class: 'v-icon', 'aria-hidden': 'true' }, ICONS[kind]), title)
      : el('h2', {}, title);
    verdict.replaceChildren(heading, ...lines);
    if (kind !== lastVerdict) {
      lastVerdict = kind;
      if (kind) morph(verdict);
    }
  }

  function renderVerdict(cur) {
    const s = ctx.settings;
    const eq = s.equipment;
    const target = parseNumber(s.target);
    const floor = parseNumber(s.floor);
    const speed = parseNumber(s.speed) || 55;
    const market = ctx.market?.active?.[eq]?.value ?? null;
    const deadhead = cur.deadhead ?? 0;

    const tiles = [];
    if (cur.loaded > 0) {
      const total = cur.loaded + deadhead;
      tiles.push(
        tile(miles(total), `total (${Math.round(cur.loaded)} loaded + ${Math.round(deadhead)} DH)`),
        tile(driveTime(total, speed), `driving at ${speed} mph`),
      );
    }

    const r = target > 0 ? evaluate({ loaded: cur.loaded, deadhead, rate: cur.rate, target, floor, market }) : null;
    if (!r) {
      show('', target > 0 ? 'Enter pickup, drop and rate' : 'Set your target $/mi under Targets');
      syncTiles($('#a-stats'), tiles);
      return;
    }

    const typo = implausibleOffer({ rate: cur.rate, totalMiles: r.totalMiles, market: market || target });
    if (typo) {
      show('check', 'Check the rate',
        el('p', { class: 'say' }, `${rpm(typo.perMile)} a mile is ${Math.round(typo.times)}× ${market ? 'the market' : 'your target'}.`),
        el('p', {}, typo.suggestion ? `Did you mean ${money(typo.suggestion, typo.suggestion % 1 !== 0)}?` : 'Make sure the number is right before you book.'));
      syncTiles($('#a-stats'), tiles);
      return;
    }

    const lines = [];
    if (r.verdict === 'book') {
      lines.push(el('p', {}, `${rpm(r.allIn)} all-in is at or above your ${rpm(target)} target.`));
    } else if (r.verdict === 'negotiate') {
      lines.push(el('p', { class: 'say' }, 'Ask ', el('span', { class: 'amt' }, money(r.askRate, false))),
        el('p', {}, `Don't go below ${money(r.floorRate, false)}.`));
    } else {
      lines.push(el('p', { class: 'say' }, 'Needs ', el('span', { class: 'amt' }, money(r.floorRate, false))),
        el('p', {}, `to be worth it. The offer is ${money(cur.rate)}.`));
    }
    if (r.marketDiff !== null) {
      const up = r.marketDiff >= 0;
      lines.push(el('div', { class: 'vs' },
        `Loaded ${rpm(r.loadedRpm)} vs ${rpm(market)}`,
        el('b', { class: up ? 'up' : 'down' }, `${up ? '+' : '−'}$${Math.abs(r.marketDiff).toFixed(2)}`)));
    }
    show(r.verdict, { book: 'Book it', negotiate: 'Negotiate', drop: 'Drop it' }[r.verdict], ...lines);

    tiles.unshift(tile(rpm(r.allIn), 'all-in $/mi', 'tile accent'), tile(rpm(r.loadedRpm), 'loaded $/mi'));
    tiles.push(tile(money(r.targetRate, false), 'rate for your target'), tile(money(r.floorRate, false), 'walk-away rate'));
    if (r.marketRate !== null) tiles.push(tile(money(r.marketRate, false), 'market × loaded miles'));
    const { pickup, dropoff } = cur.zips;
    if (pickup && dropoff) {
      const key = laneKey(pickup, dropoff);
      const same = ctx.quotes.filter((q) => q.equipment === eq && laneKey(q.pickup, q.dropoff) === key);
      if (same.length) tiles.push(tile(rpm(averageRpm(same)), `your avg on this lane (${same.length})`));
    }
    syncTiles($('#a-stats'), tiles);
  }

  // ------------------------------------------------------------ averages, targets, history

  function renderAverages() {
    const eq = ctx.settings.equipment;
    const tiles = periodAverages(ctx.quotes, eq).map((p) =>
      tile(p.rpm === null ? '—' : rpm(p.rpm), `${p.label.toLowerCase()} (${p.count})`));
    const ref = ctx.market?.active?.[eq];
    if (ref) tiles.push(tile(rpm(ref.value), `${EQUIPMENT_NAMES[eq].toLowerCase()} reference`, 'tile accent'));
    syncTiles($('#a-averages'), tiles);
  }

  function renderTargets() {
    const target = parseNumber(ctx.settings.target);
    const floor = parseNumber(ctx.settings.floor);
    $('#a-targets-hint').textContent = target > 0 ? `${rpm(target)} target · ${rpm(floor || target)} walk-away` : 'not set';
    const note = $('#a-settings-note');
    if (!(target > 0)) {
      note.textContent = 'Target $/mi is required for the verdict.';
      note.className = 'status error';
    } else if (floor > target) {
      note.textContent = 'Walk-away is above target, so the target is used for both.';
      note.className = 'status warn';
    } else {
      const ref = ctx.market?.active?.[ctx.settings.equipment];
      note.textContent = `Book it at or above target, negotiate down to walk-away, drop it below.${
        ref ? ` The reference rate (${rateSource(ref, ctx.market)}) is shown alongside.` : ''}`;
      note.className = 'status';
    }
  }

  function renderHistory() {
    const quotes = ctx.quotes;
    $('#a-history-count').textContent = quotes.length ? `${quotes.length} saved` : 'none yet';
    const box = $('#a-history');
    if (!quotes.length) {
      box.replaceChildren(el('p', { class: 'fine' }, 'Press Enter on a load to save it. Saved quotes build your averages.'));
      return;
    }
    const when = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const rows = quotes.slice(0, MAX_HISTORY_ROWS).map((q) => {
      const del = el('button', { class: 'del', type: 'button', title: 'Delete', 'aria-label': 'Delete quote' }, '✕');
      del.addEventListener('click', () => remove(q));
      return el('tr', {},
        el('td', {}, when.format(new Date(q.created * 1000))),
        el('td', {}, `${q.pickup_name ?? q.pickup} → ${q.dropoff_name ?? q.dropoff}`),
        el('td', {}, EQUIPMENT_NAMES[q.equipment] ?? q.equipment),
        el('td', { class: 'num' }, `${Math.round(q.loaded)} + ${Math.round(q.deadhead)}`),
        el('td', { class: 'num' }, money(q.rate)),
        el('td', { class: 'num' }, rpm(q.rate / (q.loaded + q.deadhead))),
        el('td', {}, del));
    });
    box.replaceChildren(el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'When'), el('th', {}, 'Lane'), el('th', {}, 'Eq'),
        el('th', { class: 'num' }, 'Mi + DH'), el('th', { class: 'num' }, 'Rate'), el('th', { class: 'num' }, 'All-in'), el('th'))),
      el('tbody', {}, ...rows)));
  }

  // ------------------------------------------------------------ actions

  async function save() {
    if (saving) return;
    const cur = ctx.load.current();
    const { pickup, dropoff } = cur.zips;
    if (!pickup || !dropoff || !(cur.loaded > 0) || !(cur.rate > 0)) {
      setStatus('Need pickup ZIP, drop ZIP, loaded miles and rate to save.', 'error');
      return;
    }
    if (cur.deadhead === null || cur.deadhead < 0) {
      setStatus('Deadhead miles is not a number (or still loading).', 'error');
      return;
    }
    saving = true;
    $('#a-save').disabled = true;
    try {
      const q = await api('/api/quotes', {
        method: 'POST',
        body: { pickup, dropoff, equipment: ctx.settings.equipment, loaded: cur.loaded, deadhead: cur.deadhead, rate: cur.rate },
      });
      ctx.quotes.unshift(q);
      ctx.clearLoad();
      const allIn = q.rate / (q.loaded + q.deadhead);
      ctx.flashStatus(() => setStatus(`Saved ${q.pickup_name ?? q.pickup} → ${q.dropoff_name ?? q.dropoff} at ${rpm(allIn)} all-in.`));
      renderHistory();
    } catch (err) {
      setStatus(`Couldn't save: ${err.message}`, 'error');
    } finally {
      saving = false;
      $('#a-save').disabled = false;
    }
  }

  async function remove(q) {
    const lane = `${q.pickup_name ?? q.pickup} → ${q.dropoff_name ?? q.dropoff}`;
    if (!confirm(`Delete the ${money(q.rate, false)} quote for ${lane}?`)) return;
    try {
      await api(`/api/quotes/${q.id}`, { method: 'DELETE' });
    } catch (err) {
      if (err.message !== 'quote not found') {
        alert(`Couldn't delete: ${err.message}`);
        return;
      }
    }
    const i = ctx.quotes.findIndex((x) => x.id === q.id);
    if (i >= 0) ctx.quotes.splice(i, 1);
    renderHistory();
    ctx.render();
  }

  return {
    show() {
      for (const [field, input] of Object.entries(inputs)) input.value = ctx.load.values[field];
      for (const input of root.querySelectorAll('[data-setting]')) input.value = ctx.settings[input.dataset.setting] ?? '';
      lastVerdict = null;
      renderHistory();
    },
    render() {
      const cur = ctx.load.current();
      // Loaded/deadhead may have been reset by a ZIP change; keep the boxes in step.
      for (const f of ['loaded', 'deadhead']) {
        if (inputs[f].value !== ctx.load.values[f] && document.activeElement !== inputs[f]) inputs[f].value = ctx.load.values[f];
      }
      renderInputs(cur);
      renderStatus(cur);
      renderVerdict(cur);
      renderAverages();
      renderTargets();
    },
    focusFirst() {
      inputs.pickup.focus();
    },
    onEnter() {
      save();
    },
    setStatus,
  };
}
