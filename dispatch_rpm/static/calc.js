// Pure calculations for rates, trips, costs and schedules. No DOM access here,
// so it can be tested with `node --test`.

const DAY_MS = 86_400_000;

/** "$2,600.50" -> 2600.5. Returns null for empty, invalid or negative input. */
export function parseNumber(text) {
  const s = String(text ?? '').replace(/[$,\s]/g, '');
  if (s === '' || !/^\d*\.?\d+$|^\d+\.$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** "60601" or "60601-1234" -> "60601"; anything else -> null. */
export function normalizeZip(text) {
  const m = /^\s*(\d{5})(?:-\d{4})?\s*$/.exec(String(text ?? ''));
  return m ? m[1] : null;
}

export function money(n, cents = true) {
  const digits = cents ? 2 : 0;
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function rpm(n) {
  return '$' + n.toFixed(2);
}

/** 968 mi at 55 mph -> "17h 36m". */
export function driveTime(miles, mph) {
  if (!(mph > 0) || !(miles >= 0)) return '—';
  const minutes = Math.round((miles / mph) * 60);
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * Score a load offer.
 *   allIn  = rate / (loaded + deadhead)  -> compared with target / walk-away
 *   loaded = rate / loaded miles         -> compared with the reference rate (`market`)
 * Three amounts to negotiate with: openingRate (the first counter, with room to
 * settle), targetRate (acceptable) and floorRate (walk away below it).
 * Returns null until there is enough input.
 */
export function evaluate({ loaded, deadhead = 0, rate, target, floor, market = null }) {
  if (!(loaded > 0) || !(rate > 0) || !(target > 0)) return null;
  deadhead = deadhead > 0 ? deadhead : 0;
  floor = floor > 0 ? Math.min(floor, target) : target;

  const totalMiles = loaded + deadhead;
  const allIn = rate / totalMiles;
  const loadedRpm = rate / loaded;
  const targetRate = roundUp(target * totalMiles);
  const floorRate = roundUp(floor * totalMiles);
  const marketRate = market > 0 ? roundUp(market * loaded) : null;
  const openingRate = roundUp(Math.max(targetRate, marketRate ?? 0) * ASK.markup, ASK.roundTo);

  let verdict;
  if (allIn >= target) verdict = 'book';
  else if (allIn >= floor) verdict = 'negotiate';
  else verdict = 'drop';

  return {
    verdict, allIn, loadedRpm, loaded, totalMiles, targetRate, floorRate, openingRate, marketRate,
    marketDiff: market > 0 ? loadedRpm - market : null,
  };
}

/**
 * Where an amount (the broker's offer, or a counter) sits against an evaluated load:
 * 'opening' (at or above the opening ask), 'acceptable' (at or above target),
 * 'low' (under target but not under walk-away) or 'below' (under walk-away).
 */
export function compareRate(amount, r) {
  if (!(amount > 0) || !r) return null;
  const band = amount >= r.openingRate ? 'opening'
    : amount >= r.targetRate ? 'acceptable'
      : amount >= r.floorRate ? 'low' : 'below';
  return {
    amount,
    allIn: amount / r.totalMiles,
    loadedRpm: amount / r.loaded,
    vsTarget: amount - r.targetRate,
    band,
  };
}

// truck types in display order, with the words the screens use for them
export const EQUIPMENT = {
  van: { name: 'Dry van', short: 'Van', plural: 'dry vans' },
  reefer: { name: 'Reefer', short: 'Reefer', plural: 'reefers' },
  flatbed: { name: 'Flatbed', short: 'Flatbed', plural: 'flatbeds' },
};

// opening counters: 5% above what you need so there's room to settle, in round
// numbers the way people talk on the phone
export const ASK = { markup: 1.05, roundTo: 25 };

// the simple version has no settings: the market average is the target
export const SIMPLE = {
  walkAwayShare: 0.85,  // pass on anything under 85% of the average
  driveHoursPerDay: 11, // FMCSA hours-of-service driving limit
  shortTripMiles: 250,
  mph: 55,
};

/** Round dollars up to a whole `step`, dropping float noise first: 2.2 * 800 is 1760.0000000000002. */
export function roundUp(n, step = 1) {
  return Math.ceil(Math.round(n * 1e6) / 1e6 / step) * step;
}

/**
 * Miles, pay per mile and driving time for the simple screen. Returns null
 * without loaded miles (e.g. pickup and delivery in the same ZIP).
 */
export function tripFacts({ loaded, deadhead = 0, rate }) {
  if (!(loaded > 0)) return null;
  const totalMiles = loaded + (deadhead > 0 ? deadhead : 0);
  const hours = totalMiles / SIMPLE.mph;
  return {
    totalMiles,
    perMile: rate > 0 ? rate / totalMiles : null,
    hours,
    days: Math.max(1, Math.ceil(hours / SIMPLE.driveHoursPerDay)),
  };
}

/**
 * Plain-language advice for the simple screen. `market` is the national
 * average $/mile; it is used as the all-in target, so deadhead counts too.
 */
export function simpleAdvice({ loaded, deadhead = 0, rate, market }) {
  if (!(market > 0)) return null;
  const r = evaluate({ loaded, deadhead, rate, target: market, floor: market * SIMPLE.walkAwayShare, market });
  if (!r) return null;
  return {
    ...r,
    ask: r.openingRate,
    minimum: roundUp(r.floorRate, ASK.roundTo),
    shortTrip: loaded < SIMPLE.shortTripMiles,
  };
}

/**
 * A rough trip cost estimate from your own assumptions. Anything not set is left
 * out and listed in `missing`; fuel isn't added when cost per mile already covers it.
 * Returns null when there's nothing to estimate with.
 */
export function tripEstimate({ totalMiles, pay, mpg, fuelPrice, costPerMile, costIncludesFuel, tolls = 0, lumper = 0 }) {
  if (!(totalMiles > 0) || !(pay > 0)) return null;
  const operating = costPerMile > 0 ? costPerMile * totalMiles : null;
  const fuelIncluded = Boolean(costIncludesFuel && operating !== null);
  const fuel = !fuelIncluded && mpg > 0 && fuelPrice > 0 ? (totalMiles / mpg) * fuelPrice : null;
  tolls = tolls > 0 ? tolls : 0;
  lumper = lumper > 0 ? lumper : 0;
  if (operating === null && fuel === null && !tolls && !lumper) return null;

  const missing = [];
  if (operating === null) missing.push('operating cost per mile');
  if (!fuelIncluded && fuel === null) missing.push(mpg > 0 ? 'diesel price' : 'MPG for fuel');
  const expenses = (operating ?? 0) + (fuel ?? 0) + tolls + lumper;
  return {
    fuel, fuelIncluded, operating, tolls, lumper, expenses, missing,
    left: pay - expenses,
    margin: (pay - expenses) / pay,
  };
}

// a rough schedule check, not an hours-of-service calculation: a 10 h break after
// each 11 h of driving, plus loading and unloading time
export const SCHEDULE = { restHours: 10, tightHours: 2, handlingHours: 2 };

const EASTERN = 'America/New_York', CENTRAL = 'America/Chicago', MOUNTAIN = 'America/Denver', PACIFIC = 'America/Los_Angeles';
const STATE_ZONES = {
  ...Object.fromEntries('CT DE DC FL GA IN KY MA MD ME MI NC NH NJ NY OH PA RI SC VA VT WV'.split(' ').map((s) => [s, EASTERN])),
  ...Object.fromEntries('AL AR IA IL KS LA MN MO MS ND NE OK SD TN TX WI'.split(' ').map((s) => [s, CENTRAL])),
  ...Object.fromEntries('CO ID MT NM UT WY'.split(' ').map((s) => [s, MOUNTAIN])),
  ...Object.fromEntries('CA NV OR WA'.split(' ').map((s) => [s, PACIFIC])),
  AZ: 'America/Phoenix', AK: 'America/Anchorage', HI: 'Pacific/Honolulu', PR: 'America/Puerto_Rico',
};
// states where part of the state keeps a different time from the zone above
const SPLIT_STATES = new Set('FL ID IN KS KY MI ND NE OR SD TN TX'.split(' '));

/** Time zone of a "City, ST" place, from its state. `split` when part of that state uses another zone. */
export function placeZone(name) {
  const state = /,\s*([A-Z]{2})$/.exec(name || '')?.[1];
  return STATE_ZONES[state] ? { zone: STATE_ZONES[state], state, split: SPLIT_STATES.has(state) } : null;
}

/** "2026-11-10T08:00" read as the clock time in `zone` -> epoch ms (daylight saving included). */
export function zonedTime(local, zone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local || '');
  if (!m) return null;
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
  });
  const offset = (ms) => {
    const p = Object.fromEntries(fmt.formatToParts(ms).map(({ type, value }) => [type, Number(value)]));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / 60_000) * 60_000;
  };
  const first = wall - offset(wall);
  return wall - offset(first);  // once more, in case the clocks change between the two
}

/**
 * Can the load make the delivery window? Times are epoch ms. Returns null until
 * there's enough to go on; status is 'ok', 'tight', 'too-tight' or 'invalid'.
 */
export function scheduleCheck({ pickupAt, deliverAt, loadedMiles, mph, loadHours, unloadHours }) {
  if (pickupAt == null || deliverAt == null || !(loadedMiles > 0) || !(mph > 0)) return null;
  const handling = (h) => (typeof h === 'number' && h >= 0 ? h : SCHEDULE.handlingHours);  // blank -> the default
  loadHours = handling(loadHours);
  unloadHours = handling(unloadHours);
  const windowHours = (deliverAt - pickupAt) / 3_600_000;
  const driveHours = loadedMiles / mph;
  const restHours = Math.max(0, Math.ceil(driveHours / SIMPLE.driveHoursPerDay) - 1) * SCHEDULE.restHours;
  const neededHours = loadHours + driveHours + restHours + unloadHours;
  const spare = windowHours - neededHours;
  const status = windowHours <= 0 ? 'invalid' : spare < 0 ? 'too-tight' : spare < SCHEDULE.tightHours ? 'tight' : 'ok';
  return { windowHours, driveHours, restHours, loadHours, unloadHours, neededHours, spare, status };
}

/** "Nov 2" from "2026-11-02", in local time. */
export function shortDate(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate || '');
  if (!m) return '';
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * An offer so far above the market that it's probably a typo (an extra zero).
 * Short trips legitimately pay more per mile, so they get more room.
 * Returns null, or { times, suggestion } where suggestion is the offer / 10
 * when that would land in a normal range.
 */
export function implausibleOffer({ rate, totalMiles, market }) {
  if (!(rate > 0) || !(totalMiles > 0) || !(market > 0)) return null;
  const perMile = rate / totalMiles;
  const limit = market * (totalMiles < 150 ? 6 : 3);
  if (perMile <= limit) return null;
  const tenth = rate / 10 / totalMiles;
  return {
    perMile,
    times: perMile / market,
    suggestion: tenth >= market * 0.5 && tenth <= market * 2 ? rate / 10 : null,
  };
}

/** Mileage-weighted all-in RPM: total dollars (offer plus stop-off) / total miles. */
export function averageRpm(quotes) {
  let dollars = 0, miles = 0;
  for (const q of quotes) {
    dollars += q.rate + (q.extras || 0);
    miles += q.loaded + q.deadhead;
  }
  return miles > 0 ? dollars / miles : null;
}

/** Group lanes by 3-digit ZIP area, the same granularity DAT uses. */
export function laneKey(pickup, dropoff) {
  return `${pickup.slice(0, 3)}-${dropoff.slice(0, 3)}`;
}

// your own history only counts when there's enough of it and it's recent
export const LANE_HISTORY = { days: 90, minLoads: 3 };

/**
 * Loaded $/mi from your saved quotes on the same lane: same truck type, same
 * direction, direct loads (no extra stops), within LANE_HISTORY.days.
 * Booked loads (at the agreed rate, plus stop-off) and offers you didn't book
 * are kept apart; `rpm` is null until there are LANE_HISTORY.minLoads of them.
 */
export function laneHistory(quotes, { pickup, dropoff, equipment, now = Date.now() }) {
  if (!pickup || !dropoff) return null;
  const key = laneKey(pickup, dropoff);
  const since = now - LANE_HISTORY.days * DAY_MS;
  const lane = quotes.filter((q) => q.equipment === equipment && laneKey(q.pickup, q.dropoff) === key
    && !q.stops?.length && q.created * 1000 >= since && q.loaded > 0);
  const summary = (list, pay) => {
    const ages = list.map((q) => Math.floor((now - q.created * 1000) / DAY_MS));
    const dollars = list.reduce((sum, q) => sum + pay(q), 0);
    const miles = list.reduce((sum, q) => sum + q.loaded, 0);
    return {
      count: list.length,
      rpm: list.length >= LANE_HISTORY.minLoads ? dollars / miles : null,
      newestDays: list.length ? Math.min(...ages) : null,
      oldestDays: list.length ? Math.max(...ages) : null,
    };
  };
  return {
    key,
    booked: summary(lane.filter((q) => q.status === 'booked'), (q) => (q.final_rate ?? q.rate) + (q.extras || 0)),
    offers: summary(lane.filter((q) => q.status !== 'booked'), (q) => q.rate),
  };
}

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Averages for today / last 7 days / last 30 days. `created` is unix seconds. */
export function periodAverages(quotes, equipment, now = Date.now()) {
  const mine = quotes.filter((q) => q.equipment === equipment);
  const periods = [
    ['Today', startOfDay(now)],
    ['Last 7 days', now - 7 * DAY_MS],
    ['Last 30 days', now - 30 * DAY_MS],
  ];
  return periods.map(([label, since]) => {
    const list = mine.filter((q) => q.created * 1000 >= since);
    return { label, count: list.length, rpm: averageRpm(list) };
  });
}

/** Whole days since a "YYYY-MM-DD" date, counted in local time. */
export function daysOld(isoDate, now = Date.now()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate || '');
  if (!m) return null;
  const then = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  return Math.round((startOfDay(now) - then) / DAY_MS);
}
