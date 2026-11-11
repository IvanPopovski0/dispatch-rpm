// Simple mode: five plain questions, one plain answer with the words to say.

import {
  EQUIPMENT, SIMPLE, driveTime, implausibleOffer, laneHistory, money, normalizeZip, parseNumber, rpm, simpleAdvice,
  tripFacts,
} from './calc.js';
import { copyButton, counterMessage, daysAgo, el, syncTiles, tile, typoHint, verdictPanel } from './common.js';
import { rateSource } from './rates.js';
import { createStopsEditor } from './stops.js';

const ORDER = ['truck', 'pickup', 'dropoff', 'rate'];

export function createSimpleView(root, ctx) {
  const $ = (sel) => root.querySelector(sel);
  const inputs = Object.fromEntries(ORDER.map((f) => [f, $(`[data-field="${f}"]`)]));
  const { show, reset } = verdictPanel($('#s-answer'));
  const facts = $('#s-facts');
  const stops = createStopsEditor(root, ctx);

  for (const [field, input] of Object.entries(inputs)) {
    input.addEventListener('input', () => ctx.edit(field, input.value));
  }
  $('#s-next').addEventListener('click', () => ctx.clearLoad());

  function setFound(field, text, kind = '') {
    const node = $(`[data-found="${field}"]`);
    node.textContent = text;
    node.className = `found ${kind}`;
  }

  function renderFound(cur) {
    const { load } = ctx;
    for (const field of ['truck', 'pickup', 'dropoff']) {
      const text = load.values[field].trim();
      const s = cur.places[field];
      inputs[field].classList.toggle('invalid', text !== '' && !normalizeZip(text));
      if (text === '') setFound(field, field === 'truck' ? 'Leave empty if the truck is already at the pickup.' : '', 'dim');
      else if (!normalizeZip(text)) setFound(field, 'A ZIP code is 5 numbers, like 30318.', 'error');
      else if (s.status === 'ok') setFound(field, `✓ ${s.data.name}`);
      else if (s.status === 'error') setFound(field, s.error, 'error');
      else setFound(field, 'Checking…', 'dim');
    }
    $('[data-rate-label]').textContent = cur.partials > 1 ? 'What does the first pickup pay?' : 'What is the broker paying?';
    $('[data-rate-hint]').textContent = cur.partials > 1 ? '$' : 'total $';
    const rateText = load.values.rate.trim();
    const badRate = rateText !== '' && parseNumber(rateText) === null;
    inputs.rate.classList.toggle('invalid', badRate);
    setFound('rate', badRate ? 'Type just the number, like 2000.' : '', 'error');
  }

  function renderAnswer(cur) {
    const eq = ctx.settings.equipment;
    const ref = ctx.market?.active?.[eq];
    const market = ref?.value ?? null;

    if (!cur.zips.pickup || !cur.zips.dropoff) {
      facts.replaceChildren();
      return show('', 'Fill in the questions');
    }
    if (cur.stopsIncomplete) {
      facts.replaceChildren();
      return show('', 'Fill in every stop', el('p', {}, 'Type a ZIP for each stop, or remove the empty ones.'));
    }
    if (cur.tripError) {
      facts.replaceChildren();
      return show('', "Couldn't find the miles", el('p', {}, `${cur.tripError}. Check the ZIP codes, or switch to Advanced and type the miles.`));
    }
    if (cur.pending || cur.loaded === null) {
      facts.replaceChildren();
      return show('pending', 'Finding the miles…');
    }
    const deadhead = cur.deadhead ?? 0;
    const trip = tripFacts({ loaded: cur.loaded, deadhead, rate: cur.pay });
    if (!trip) {
      facts.replaceChildren();
      const why = cur.zips.pickup === cur.zips.dropoff
        ? 'Pickup and delivery are the same ZIP code'
        : 'This trip has no loaded miles';
      return show('', 'No miles to measure',
        el('p', {}, `${why}. For a local load, switch to Advanced and type the loaded miles.`));
    }
    syncTiles(facts, [
      tile(`${Math.round(trip.totalMiles).toLocaleString('en-US')} mi`, `${Math.round(cur.loaded)} loaded + ${Math.round(deadhead)} empty`),
      tile(trip.perMile !== null ? `${rpm(trip.perMile)}/mi` : '—', 'pays per mile, all miles'),
      tile(driveTime(trip.totalMiles, SIMPLE.mph), `driving, about ${trip.days} day${trip.days > 1 ? 's' : ''}`),
    ]);

    const several = cur.partials > 1;  // LTL / partial: more than one pickup, each paying its own rate
    if (!(cur.pay > 0)) return show('', several ? 'What does each pickup pay?' : 'What is the broker paying?');
    if (!market) return show('', 'No rate for this truck type yet', el('p', {}, 'Open Rates (top right) to set one.'));

    const typo = implausibleOffer({ rate: cur.pay, totalMiles: trip.totalMiles, market });
    if (typo) {
      return show('check', 'Check the offer',
        el('p', { class: 'say' }, `That’s ${rpm(typo.perMile)} a mile, ${Math.round(typo.times)}× the average.`),
        typoHint(typo));
    }
    const a = simpleAdvice({ loaded: cur.loaded, deadhead, rate: cur.pay, market });
    const offer = money(cur.pay, cur.pay % 1 !== 0) + (cur.stopoff ? ' with stop-off' : '');
    const amount = (n) => el('span', { class: 'amt' }, money(n, false));
    const copy = () => el('p', {}, copyButton('Copy message', () => counterMessage({
      from: cur.places.pickup.data?.name ?? cur.zips.pickup, to: cur.places.dropoff.data?.name ?? cur.zips.dropoff,
      stops: cur.stops.length, miles: cur.loaded, amount: a.ask,
    })));
    const extra = [];
    if (a.shortTrip) extra.push(el('p', { class: 'warn' }, 'Short trip: these usually pay more per mile than the average, so it’s fine to ask for more.'));
    if (cur.stopoff) extra.push(el('p', {}, `Includes ${money(cur.stopoff, false)} stop-off pay entered in Advanced.`));
    if (cur.emptyError) extra.push(el('p', { class: 'warn' }, 'Couldn’t get the empty miles to pickup, so they aren’t counted.'));
    if (cur.estimated) extra.push(el('p', { class: 'warn' }, 'Miles are estimated (the map service is busy). Ask the broker for the miles to be sure.'));

    if (a.verdict === 'book') {
      show('book', 'Take it',
        el('p', { class: 'say' }, 'Say: “Sounds good, let’s book it.”'),
        el('p', {}, `${several ? 'Together they pay' : 'Pays'} ${rpm(a.allIn)} a mile, against ${rpm(market)} for ${EQUIPMENT[eq].plural}.`), ...extra);
    } else if (a.verdict === 'negotiate') {
      show('negotiate', 'Ask for more', ...(several ? [
        el('p', { class: 'say' }, 'Ask for ', amount(a.ask), ' in total'),
        el('p', {}, `That’s ${money(a.ask - cur.pay, false)} more across the ${cur.partials} pickups. If they won’t go higher, ${offer} together is still OK to take.`),
      ] : [
        el('p', { class: 'say' }, 'Say: “I can do it for ', amount(a.ask), '.”'),
        el('p', {}, `If they won’t go higher, their ${offer} is still OK to take.`),
      ]), ...(several ? [] : [copy()]), ...extra);
    } else {
      show('drop', 'Too low', ...(several ? [
        el('p', { class: 'say' }, 'You’d need ', amount(a.ask), ' in total'),
        el('p', {}, `If the ${cur.partials} pickups can’t add up to at least ${money(a.minimum, false)}, say “No thanks” and move on.`),
      ] : [
        el('p', { class: 'say' }, 'Say: “I’d need ', amount(a.ask), ' for this one.”'),
        el('p', {}, `If they can’t pay at least ${money(a.minimum, false)}, say “No thanks” and move on.`),
      ]), ...(several ? [] : [copy()]), ...extra);
    }
  }

  /** One line from your own booked loads on this lane, only when there are enough of them. */
  function renderHistory(cur) {
    const { pickup, dropoff } = cur.zips;
    const h = pickup && dropoff && !cur.stops.length
      ? laneHistory(ctx.quotes, { pickup, dropoff, equipment: ctx.settings.equipment }) : null;
    $('#s-history').textContent = h?.booked.rpm != null
      ? `Your history: you booked this lane at ${rpm(h.booked.rpm)}/mi loaded (${h.booked.count} loads, latest ${daysAgo(h.booked.newestDays)}).`
      : '';
  }

  function renderNote() {
    const eq = ctx.settings.equipment;
    const ref = ctx.market?.active?.[eq];
    const note = $('#s-note');
    if (!ref) {
      note.textContent = '';
      return;
    }
    note.replaceChildren(`Measured against ${rpm(ref.value)}/mi for ${EQUIPMENT[eq].plural}: ${rateSource(ref, ctx.market)}.`);
    if (ref.stale) note.append(' ', el('span', { class: 'warn' }, 'This rate may be out of date.'));
  }

  return {
    show() {
      for (const [field, input] of Object.entries(inputs)) input.value = ctx.load.values[field];
      reset();
    },
    render() {
      const cur = ctx.load.current();
      renderFound(cur);
      stops.render(cur);
      renderAnswer(cur);
      renderHistory(cur);
      renderNote();
    },
    focusFirst() {
      inputs[ctx.load.values.truck ? 'pickup' : 'truck'].focus();
    },
    onEnter(target) {
      // Enter moves to the next question, like Tab
      const field = target.dataset.field;
      const next = ORDER[ORDER.indexOf(field) + 1];
      if (next) inputs[next].focus(); else target.blur();
    },
  };
}
