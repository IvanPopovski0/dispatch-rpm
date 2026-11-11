// Advanced mode: every number, your own targets, saved quotes and averages.

import {
  EQUIPMENT, LANE_HISTORY, compareRate, driveTime, evaluate, implausibleOffer, laneHistory, money, normalizeZip,
  parseNumber, periodAverages, placeZone, rpm, scheduleCheck, tripEstimate, zonedTime,
} from './calc.js';
import { api, copyButton, counterMessage, daysAgo, el, syncTiles, tile, typoHint, verdictPanel } from './common.js';
import { rateSource, referenceName } from './rates.js';
import { createStopsEditor } from './stops.js';

const NUMERIC_SETTINGS = ['target', 'floor', 'speed', 'mpg', 'cost_per_mile', 'fuel_price'];
const MONEY_FIELDS = ['stopoff', 'detention', 'layover', 'tolls', 'lumper'];
const SCHEDULE_FIELDS = ['pickup_at', 'deliver_at', 'load_h', 'unload_h'];
const FIELDS = ['truck', 'pickup', 'dropoff', 'loaded', 'deadhead', 'rate', 'counter', 'broker', 'mc', 'notes', 'status', 'final',
  ...MONEY_FIELDS, ...SCHEDULE_FIELDS];
const ZONE_NAMES = {
  'America/New_York': 'Eastern', 'America/Chicago': 'Central', 'America/Denver': 'Mountain', 'America/Phoenix': 'Arizona',
  'America/Los_Angeles': 'Pacific', 'America/Anchorage': 'Alaska', 'Pacific/Honolulu': 'Hawaii', 'America/Puerto_Rico': 'Atlantic',
};
const hours = (h) => `${Math.round(h)} h`;
const VERDICT_TITLE = { book: 'Book it', negotiate: 'Negotiate', drop: 'Drop it' };
const placeName = (cur, field) => (cur.places[field].status === 'ok' ? cur.places[field].data.name : cur.zips[field]);
const MC_RE = /^(?:MC[\s#-]*)?\d{1,8}$/i;
const STATUS = { quoted: 'Quoted', booked: 'Booked', passed: 'Passed' };
const MAX_HISTORY_ROWS = 300;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const laneName = (q) => `${q.pickup_name ?? q.pickup} → ${q.dropoff_name ?? q.dropoff}${
  q.stops?.length ? ` · ${plural(q.stops.length, 'stop')}` : ''}`;
const quoteRpm = (q) => (q.rate + (q.extras || 0)) / (q.loaded + q.deadhead);
const signed = (n) => `${n >= 0 ? '+' : '−'}${money(Math.abs(n), false)}`;
const BAND = {
  opening: 'at or above your opening ask',
  acceptable: 'acceptable (at or above your target)',
  low: 'under your target but above walk-away',
  below: 'under your walk-away',
};

export function createAdvancedView(root, ctx) {
  const $ = (sel) => root.querySelector(sel);
  const inputs = Object.fromEntries(FIELDS.map((f) => [f, $(`[data-field="${f}"]`)]));
  const filter = $('#a-history-filter');
  const { show, reset } = verdictPanel($('#a-verdict'));
  const stops = createStopsEditor(root, ctx);
  const nego = $('#a-nego');
  let message = '';
  const copyRow = el('div', { class: 'row' }, copyButton('Copy message', () => message));
  nego.append(copyRow);
  let summary = '';
  const copyQuote = copyButton('Copy quote', () => summary);
  $('#a-actions').append(copyQuote);
  let saving = false;

  for (const [field, input] of Object.entries(inputs)) {
    input.addEventListener('input', () => ctx.edit(field, input.value));
  }
  for (const input of root.querySelectorAll('[data-setting]')) {
    input.addEventListener('input', () => ctx.setSetting(input.dataset.setting, input.value));
  }
  $('#a-save').addEventListener('click', save);
  filter.addEventListener('input', renderHistory);
  $('#a-clear').addEventListener('click', () => ctx.clearLoad());

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
    for (const f of ['loaded', 'deadhead', 'rate', 'counter', 'final', 'load_h', 'unload_h', ...MONEY_FIELDS]) {
      bad(inputs[f], parseNumber(inputs[f].value) !== null);
    }
    bad(inputs.mc, MC_RE.test(inputs.mc.value.trim()));
    for (const key of NUMERIC_SETTINGS) {
      const input = root.querySelector(`[data-setting="${key}"]`);
      bad(input, parseNumber(input.value) !== null);
    }
    $('[data-rate-label]').textContent = cur.partials > 1 ? 'Pickup 1 rate $' : 'Offered rate $';
    inputs.loaded.placeholder = cur.loadedAuto !== null ? `${cur.loadedAuto} (auto)` : 'auto';
    inputs.deadhead.placeholder = cur.emptyLookup
      ? (cur.deadheadAuto !== null ? `${cur.deadheadAuto} (auto)` : '…')
      : '0';

    renderDetails();

    const link = $('#a-gmaps');
    const { pickup, dropoff } = cur.zips;
    link.hidden = !(pickup && dropoff);
    if (pickup && dropoff) {
      const via = cur.stops.filter((s) => s.zip).map((s) => `${s.zip}%2C%20USA`).join('%7C');
      link.href = `https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=${pickup}%2C%20USA&destination=${dropoff}%2C%20USA${
        via ? `&waypoints=${via}` : ''}`;
    }
  }

  /** Broker & notes: the agreed rate only for a booked load, and earlier quotes with the same broker. */
  function renderDetails() {
    const { values } = ctx.load;
    const broker = values.broker.trim();
    $('#a-final-label').hidden = values.status !== 'booked';
    $('#a-details-hint').textContent = [broker, STATUS[values.status || 'quoted']].filter(Boolean).join(' · ');
    const earlier = broker ? ctx.quotes.filter((q) => q.broker.toLowerCase() === broker.toLowerCase()).length : 0;
    const hint = $('#a-broker-hint');
    if (!earlier) {
      hint.replaceChildren();
      return;
    }
    const showThem = el('button', { type: 'button', class: 'link' }, 'Show them');
    showThem.addEventListener('click', () => {
      filter.value = broker;
      $('#a-history-card').open = true;
      renderHistory();
    });
    hint.replaceChildren(`${plural(earlier, 'earlier quote')} with ${broker}. `, showThem);
  }

  /** [text, kind] about the load being typed; empty text when there's nothing to say. */
  function liveStatus(cur) {
    if (!cur.zips.pickup || !cur.zips.dropoff) return [''];
    if (cur.stopsIncomplete) return ['Type a ZIP for each stop.'];
    if (cur.tripError) return [`${cur.tripError}. Type the miles in.`, 'error'];
    if (cur.tripLoading) return ['Looking up miles…'];
    const r = cur.route;
    if (!r) return [''];
    let text = `${r.pickup} → ${r.stops ? `${plural(r.stops, 'stop')} → ` : ''}${r.dropoff}: ${miles(r.miles)}`;
    if (cur.loadedTyped) text += ` (using your ${miles(cur.loaded ?? 0)})`;
    if (cur.emptyLookup && cur.deadheadAuto !== null) text += ` · truck to pickup ${miles(cur.deadheadAuto)}`;
    if (cur.estimated) return [`${text}. ESTIMATE, the route server is busy, so double-check.`, 'warn'];
    if (cur.emptyError) return [`${text}. Couldn't get empty miles: ${cur.emptyError}`, 'warn'];
    return [text];
  }

  function renderStatus(cur) {
    const [text, kind] = liveStatus(cur);
    if (ctx.flash) {
      if (!text) return; // keep the save message until there's news about the next load
      ctx.flash = false;
    }
    setStatus(text, kind);
  }

  // ------------------------------------------------------------ verdict

  function renderVerdict(cur) {
    const s = ctx.settings;
    const eq = s.equipment;
    const target = parseNumber(s.target);
    const floor = parseNumber(s.floor);
    const speed = parseNumber(s.speed) || 55;
    const ref = ctx.market?.active?.[eq];
    const market = ref?.value ?? null;
    const refName = referenceName(ref);
    const schedule = renderSchedule(cur, speed);
    const deadhead = cur.deadhead ?? 0;
    summary = '';
    copyQuote.hidden = true;

    const tiles = [];
    if (cur.loaded > 0) {
      const total = cur.loaded + deadhead;
      tiles.push(
        tile(miles(total), `total (${Math.round(cur.loaded)} loaded + ${Math.round(deadhead)} DH)`),
        tile(driveTime(total, speed), `driving at ${speed} mph`),
      );
    }

    const r = target > 0 ? evaluate({ loaded: cur.loaded, deadhead, rate: cur.pay, target, floor, market }) : null;
    if (!r) {
      const noMiles = cur.route && !(cur.loaded > 0);  // e.g. pickup and delivery in the same ZIP
      show(cur.tripLoading ? 'pending' : '', !(target > 0) ? 'Set your target $/mi under Targets'
        : noMiles ? 'Type the loaded miles' : 'Enter pickup, drop and rate');
      syncTiles($('#a-stats'), tiles);
      renderNegotiation(cur, null);
      return;
    }

    const typo = implausibleOffer({ rate: cur.pay, totalMiles: r.totalMiles, market: market || target });
    if (typo) {
      show('check', 'Check the rate',
        el('p', { class: 'say' }, `${rpm(typo.perMile)} a mile is ${Math.round(typo.times)}× ${market ? `the ${refName}` : 'your target'}.`),
        typoHint(typo));
      syncTiles($('#a-stats'), tiles);
      renderNegotiation(cur, null);
      return;
    }

    const lines = [];
    if (r.verdict === 'book') {
      lines.push(el('p', {}, `${rpm(r.allIn)} all-in is at or above your ${rpm(target)} target.`));
    } else if (r.verdict === 'negotiate') {
      lines.push(el('p', { class: 'say' }, 'Ask ', el('span', { class: 'amt' }, money(r.openingRate, false))),
        el('p', {}, `Acceptable from ${money(r.targetRate, false)}. Don't go below ${money(r.floorRate, false)}.`));
    } else {
      lines.push(el('p', { class: 'say' }, 'Needs ', el('span', { class: 'amt' }, money(r.floorRate, false))),
        el('p', {}, `to be worth it. ${cur.partials > 1 ? `The ${cur.partials} pickups pay` : 'The offer is'} ${money(cur.pay, cur.pay % 1 !== 0)}${
          cur.stopoff ? ' with stop-off' : ''}.`));
    }
    if (schedule && schedule.check.status !== 'ok') lines.push(el('p', { class: 'warn' }, schedule.headline));
    if (r.marketDiff !== null) {
      const up = r.marketDiff >= 0;
      lines.push(el('div', { class: 'vs' },
        `Loaded ${rpm(r.loadedRpm)} vs ${rpm(market)} ${refName}`,
        el('b', { class: up ? 'up' : 'down' }, `${up ? '+' : '−'}$${Math.abs(r.marketDiff).toFixed(2)}`)));
    }
    show(r.verdict, VERDICT_TITLE[r.verdict], ...lines);

    // one line with the numbers that matter, to paste into notes or a message to a colleague
    summary = [
      `${placeName(cur, 'pickup')} → ${placeName(cur, 'dropoff')}${cur.stops.length ? ` (${plural(cur.stops.length, 'stop')})` : ''}`,
      `${Math.round(cur.loaded)} loaded + ${Math.round(deadhead)} empty mi`,
      `offer ${money(cur.pay, cur.pay % 1 !== 0)}${cur.stopoff ? ' incl. stop-off' : ''}`,
      `${rpm(r.allIn)}/mi all-in, ${rpm(r.loadedRpm)}/mi loaded`,
      `${VERDICT_TITLE[r.verdict]}${r.verdict === 'book' ? ''
        : `: ask ${money(r.openingRate, false)}, walk away under ${money(r.floorRate, false)}`}`,
    ].join(' · ');
    copyQuote.hidden = false;

    tiles.unshift(tile(rpm(r.allIn), 'all-in $/mi', 'tile accent'), tile(rpm(r.loadedRpm), 'loaded $/mi'));
    if (r.marketRate !== null) tiles.push(tile(money(r.marketRate, false), `${refName} × loaded mi`));
    syncTiles($('#a-stats'), tiles);
    renderNegotiation(cur, r);
    renderCosts(cur, r);
  }

  /**
   * Pickup and delivery times against the drive: each time is read in its own stop's time zone.
   * Returns { check, headline } for the verdict, or null when there's nothing to check.
   */
  function renderSchedule(cur, mph) {
    const { values } = ctx.load;
    const out = $('#a-schedule');
    const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const zone = (field) => placeZone(cur.places[field].status === 'ok' ? cur.places[field].data.name : '');
    const from = zone('pickup');
    const to = zone('dropoff');
    const check = scheduleCheck({
      pickupAt: zonedTime(values.pickup_at, from?.zone ?? here), deliverAt: zonedTime(values.deliver_at, to?.zone ?? here),
      loadedMiles: cur.loaded, mph, loadHours: parseNumber(values.load_h), unloadHours: parseNumber(values.unload_h),
    });
    if (!check) {
      out.textContent = values.pickup_at && values.deliver_at && !(cur.loaded > 0) ? 'Needs the loaded miles to check.' : '';
      out.className = 'status';
      return null;
    }
    const headline = {
      invalid: 'Delivery is before pickup. Check the dates and times.',
      'too-tight': `Schedule looks too tight: about ${hours(check.neededHours)} needed, ${hours(check.windowHours)} between appointments.`,
      tight: `Schedule is tight: only about ${hours(check.spare)} to spare.`,
      ok: `Schedule looks workable: about ${hours(check.spare)} to spare.`,
    }[check.status];
    const zones = [from, to].map((z) => (z ? ZONE_NAMES[z.zone] : 'this computer’s'));
    const split = [from, to].filter((z) => z?.split).map((z) => z.state);
    const detail = check.status === 'invalid' ? '' : ` ${hours(check.loadHours)} loading + ${hours(check.driveHours)} driving${
      check.restHours ? ` + ${hours(check.restHours)} of breaks` : ''} + ${hours(check.unloadHours)} unloading.`;
    out.textContent = `${headline}${detail} Times read as ${zones[0]} → ${zones[1]} time${
      split.length ? ` (parts of ${[...new Set(split)].join(' and ')} use another zone)` : ''}. `
      + 'Rough estimate: check driver availability and hours of service separately.';
    out.className = `status ${check.status === 'ok' ? '' : check.status === 'tight' ? 'warn' : 'error'}`;
    return { check, headline };
  }

  /** Trip costs from your own assumptions. An estimate, never called profit; it says what it leaves out. */
  function renderCosts(cur, r) {
    const s = ctx.settings;
    const box = $('#a-costs');
    const diesel = ctx.market?.diesel;
    const ownPrice = parseNumber(s.fuel_price);
    const est = r && tripEstimate({
      totalMiles: r.totalMiles, pay: cur.pay, mpg: parseNumber(s.mpg), fuelPrice: ownPrice ?? diesel?.price,
      costPerMile: parseNumber(s.cost_per_mile), costIncludesFuel: s.cost_includes_fuel === '1',
      tolls: parseNumber(ctx.load.values.tolls), lumper: parseNumber(ctx.load.values.lumper),
    });
    const possible = (parseNumber(ctx.load.values.detention) ?? 0) + (parseNumber(ctx.load.values.layover) ?? 0);
    box.hidden = !est;
    if (!est) return;
    const row = (label, amount, note = '') => el('tr', {}, el('th', {}, label),
      el('td', { class: 'num' }, amount === null ? '—' : money(amount, false)), el('td', {}, note));
    const fuelNote = est.fuelIncluded ? 'in cost per mile'
      : est.fuel === null ? 'not set'
        : `${parseNumber(s.mpg)} mpg at ${money(ownPrice ?? diesel.price)}/gal${ownPrice ? '' : ' (EIA weekly)'}`;
    $('#a-costs-table').replaceChildren(el('tbody', {},
      row(cur.stopoff ? 'Pay (offer + stop-off)' : 'Pay (offer)', cur.pay),
      row('Fuel', est.fuelIncluded ? null : est.fuel, fuelNote),
      row('Operating', est.operating, est.operating === null ? 'not set' : `${money(parseNumber(s.cost_per_mile))}/mi`),
      ...(est.tolls ? [row('Tolls', est.tolls)] : []),
      ...(est.lumper ? [row('Lumper (you pay)', est.lumper)] : []),
      row('Costs entered', est.expenses),
      row('Left after these costs', est.left, `${Math.round(est.margin * 100)}% of pay`)));
    const notes = [];
    if (est.missing.length) notes.push(`Not counted: ${est.missing.join(', ')}.`);
    if (possible) notes.push(`Possible detention/layover pay of ${money(possible, false)} isn’t counted until it’s paid.`);
    $('#a-costs-note').textContent = notes.join(' ');
  }

  /** Opening ask, acceptable and walk-away next to the broker's offer and your counter. */
  function renderNegotiation(cur, r) {
    nego.hidden = !r;
    if (!r) return;
    const offer = compareRate(cur.pay, r);
    const counter = compareRate(cur.counter, r);
    const rows = [
      ['Opening ask', compareRate(r.openingRate, r)],
      ['Acceptable (target)', compareRate(r.targetRate, r)],
      ['Walk-away', compareRate(r.floorRate, r)],
      [`${cur.partials > 1 ? 'Broker offers (total)' : 'Broker offer'}${cur.stopoff ? ' + stop-off' : ''}`, offer],
      ...(counter ? [['Your counter', counter]] : []),
    ].map(([label, c]) => el('tr', {},
      el('th', {}, label),
      el('td', { class: 'num' }, money(c.amount, c.amount % 1 !== 0)),
      el('td', { class: 'num' }, rpm(c.allIn)),
      el('td', { class: 'num' }, rpm(c.loadedRpm)),
      el('td', { class: 'num' }, Math.abs(c.vsTarget) < 0.005 ? '—' : signed(c.vsTarget))));
    const head = ['Total', 'All-in/mi', 'Loaded/mi', 'vs target'].map((h) => el('th', { class: 'num' }, h));
    $('#a-nego-table').replaceChildren(el('thead', {}, el('tr', {}, el('th'), ...head)), el('tbody', {}, ...rows));

    const note = $('#a-nego-note');
    note.textContent = `The offer is ${BAND[offer.band]}.${
      counter ? ` Your counter is ${BAND[counter.band]}, ${signed(counter.amount - offer.amount)} vs the offer.` : ''}`;
    note.className = `status ${counter?.band === 'below' ? 'warn' : ''}`;

    // with several pickups each broker pays their own part, so one message for the total would mislead
    message = cur.partials > 1 ? '' : counterMessage({
      from: placeName(cur, 'pickup'), to: placeName(cur, 'dropoff'), stops: cur.stops.length, miles: r.loaded,
      amount: counter ? counter.amount : r.openingRate,
    });
    copyRow.hidden = !message;
    $('#a-nego-message').textContent = message && `“${message}”`;
    $('#a-lane-history').textContent = laneHistoryText(cur, offer);
  }

  /** Your own booked loads on this lane, kept apart from offers you didn't book. Never called market data. */
  function laneHistoryText(cur, offer) {
    if (cur.stops.length) return 'Your lane history covers direct loads only, so it isn’t compared here.';
    const eq = ctx.settings.equipment;
    const h = laneHistory(ctx.quotes, { pickup: cur.zips.pickup, dropoff: cur.zips.dropoff, equipment: eq });
    const where = `ZIP areas ${h.key.replace('-', ' → ')}, ${EQUIPMENT[eq].plural}, last ${LANE_HISTORY.days} days`;
    let text;
    if (h.booked.rpm === null) {
      text = `Your lane history (${where}): not enough booked loads yet, ${h.booked.count} of ${LANE_HISTORY.minLoads}.`;
    } else {
      const diff = offer.loadedRpm - h.booked.rpm;
      text = `Your booked loads (${where}): ${rpm(h.booked.rpm)}/mi loaded on average from ${h.booked.count}, `
        + `latest ${daysAgo(h.booked.newestDays)}. This offer is ${rpm(Math.abs(diff))}/mi ${diff >= 0 ? 'above' : 'below'} that.`;
    }
    if (h.offers.rpm !== null) {
      text += ` Offers you didn’t book averaged ${rpm(h.offers.rpm)}/mi loaded (${h.offers.count}).`;
    }
    return text;
  }

  // ------------------------------------------------------------ averages, targets, history

  function renderAverages() {
    const eq = ctx.settings.equipment;
    const tiles = periodAverages(ctx.quotes, eq).map((p) =>
      tile(p.rpm === null ? '—' : rpm(p.rpm), `${p.label.toLowerCase()} (${p.count})`));
    const ref = ctx.market?.active?.[eq];
    if (ref) tiles.push(tile(rpm(ref.value), `${EQUIPMENT[eq].name.toLowerCase()} reference`, 'tile accent'));
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
    const term = filter.value.trim().toLowerCase();
    const quotes = term
      ? ctx.quotes.filter((q) => [q.broker, q.mc, q.notes, q.pickup, q.dropoff, q.pickup_name, q.dropoff_name]
        .join(' ').toLowerCase().includes(term))
      : ctx.quotes;
    $('#a-history-count').textContent = ctx.quotes.length ? `${ctx.quotes.length} saved` : 'none yet';
    const box = $('#a-history');
    if (!quotes.length) {
      box.replaceChildren(el('p', { class: 'fine' }, term ? 'No saved quotes match.'
        : 'Press Enter on a load to save it. Saved quotes build your averages.'));
      return;
    }
    const when = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const rows = quotes.slice(0, MAX_HISTORY_ROWS).map((q) => {
      const del = el('button', { class: 'del', type: 'button', title: 'Delete', 'aria-label': 'Delete quote' }, '✕');
      del.addEventListener('click', () => remove(q));
      const status = el('select', { 'aria-label': 'Quote status' },
        ...Object.entries(STATUS).map(([value, label]) => el('option', { value }, label)));
      status.value = q.status;
      status.addEventListener('change', () => setOutcome(q, status.value, q.final_rate));
      let agreed = '—';
      if (q.status === 'booked') {
        agreed = el('input', { inputmode: 'decimal', placeholder: 'agreed $', 'aria-label': 'Agreed rate' });
        agreed.value = q.final_rate ?? '';
        agreed.addEventListener('change', () => setOutcome(q, 'booked', parseNumber(agreed.value)));
      }
      const who = [q.broker, q.mc && `MC ${q.mc}`, q.notes].filter(Boolean).join(' · ');
      return el('tr', {},
        el('td', {}, when.format(new Date(q.created * 1000))),
        el('td', {}, laneName(q), ...(who ? [el('span', { class: 'lane-note' }, who)] : [])),
        el('td', {}, EQUIPMENT[q.equipment]?.name ?? q.equipment),
        el('td', { class: 'num' }, `${Math.round(q.loaded)} + ${Math.round(q.deadhead)}`),
        el('td', { class: 'num' }, money(q.rate)),
        el('td', { class: 'num' }, rpm(quoteRpm(q))),
        el('td', {}, status),
        el('td', { class: 'num' }, agreed),
        el('td', {}, del));
    });
    const head = [['When'], ['Lane'], ['Eq'], ['Mi + DH', 'num'], ['Offer', 'num'], ['All-in', 'num'], ['Status'], ['Agreed', 'num'], ['']]
      .map(([label, cls]) => el('th', cls ? { class: cls } : {}, label));
    box.replaceChildren(el('table', {}, el('thead', {}, el('tr', {}, ...head)), el('tbody', {}, ...rows)));
  }

  /** How a saved quote turned out: quoted, booked (with the agreed rate, if known) or passed. */
  async function setOutcome(q, status, finalRate) {
    try {
      const updated = await api(`/api/quotes/${q.id}`, {
        method: 'POST',
        body: { status, final_rate: status === 'booked' ? finalRate : null, notes: q.notes },
      });
      ctx.quotes.splice(ctx.quotes.findIndex((x) => x.id === q.id), 1, updated);
    } catch (err) {
      alert(`Couldn't update the quote: ${err.message}`);
    }
    renderHistory();
    ctx.render();
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
    if (cur.stopsIncomplete) {
      setStatus('Every stop needs a ZIP (or remove the empty ones).', 'error');
      return;
    }
    if (cur.deadhead === null || cur.deadhead < 0) {
      setStatus('Deadhead miles is not a number (or still loading).', 'error');
      return;
    }
    const { values } = ctx.load;
    if (values.mc.trim() && !MC_RE.test(values.mc.trim())) {
      setStatus('MC number is up to 8 digits, like MC 123456.', 'error');
      return;
    }
    const status = values.status || 'quoted';
    saving = true;
    $('#a-save').disabled = true;
    try {
      const q = await api('/api/quotes', {
        method: 'POST',
        body: {
          pickup, dropoff, equipment: ctx.settings.equipment, loaded: cur.loaded, deadhead: cur.deadhead, rate: cur.rate,
          stops: cur.stops.map(({ zip, kind, rate }) => (kind === 'pickup' ? { zip, kind, rate } : { zip, kind })),
          counter: cur.counter, extras: cur.stopoff, broker: values.broker, mc: values.mc, notes: values.notes, status,
          final_rate: status === 'booked' ? parseNumber(values.final) : null,
        },
      });
      ctx.quotes.unshift(q);
      ctx.clearLoad();
      ctx.flashStatus(() => setStatus(`Saved ${laneName(q)} at ${rpm(quoteRpm(q))} all-in${
        q.status === 'quoted' ? '' : `, ${STATUS[q.status].toLowerCase()}`}.`));
      renderHistory();
    } catch (err) {
      setStatus(`Couldn't save: ${err.message}`, 'error');
    } finally {
      saving = false;
      $('#a-save').disabled = false;
    }
  }

  async function remove(q) {
    if (!confirm(`Delete the ${money(q.rate, false)} quote for ${laneName(q)}?`)) return;
    try {
      await api(`/api/quotes/${q.id}`, { method: 'DELETE' });
    } catch (err) {
      if (err.status !== 404) {
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
      reset();
      renderHistory();
    },
    render() {
      const cur = ctx.load.current();
      // loaded/deadhead may have been reset by a ZIP change; keep the boxes in step
      for (const f of ['loaded', 'deadhead']) {
        if (inputs[f].value !== ctx.load.values[f] && document.activeElement !== inputs[f]) inputs[f].value = ctx.load.values[f];
      }
      renderInputs(cur);
      stops.render(cur);
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
  };
}
