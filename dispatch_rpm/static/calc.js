// Pure rate math. No DOM access here so it can be tested with `node --test`.

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
 *   loaded = rate / loaded miles         -> compared with the market average
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
  const marketRate = market > 0 ? Math.round(market * loaded) : null;

  let verdict, askRate = null;
  if (allIn >= target) {
    verdict = 'book';
  } else if (allIn >= floor) {
    verdict = 'negotiate';
    askRate = Math.max(targetRate, marketRate ?? 0);
  } else {
    verdict = 'drop';
  }

  return {
    verdict, allIn, loadedRpm, totalMiles, targetRate, floorRate, askRate, marketRate,
    marketDiff: market > 0 ? loadedRpm - market : null,
  };
}

// Truck types in display order, with the words the screens use for them.
export const EQUIPMENT = {
  van: { name: 'Dry van', short: 'Van', plural: 'dry vans' },
  reefer: { name: 'Reefer', short: 'Reefer', plural: 'reefers' },
  flatbed: { name: 'Flatbed', short: 'Flatbed', plural: 'flatbeds' },
};

// The simple version has no settings: the market average is the target.
export const SIMPLE = {
  walkAwayShare: 0.85,  // pass on anything under 85% of the average
  counterMarkup: 1.05,  // counter 5% above the average so there's room to settle
  roundTo: 25,          // quote round numbers, the way people talk on the phone
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
    ask: roundUp(r.targetRate * SIMPLE.counterMarkup, SIMPLE.roundTo),
    minimum: roundUp(r.floorRate, SIMPLE.roundTo),
    shortTrip: loaded < SIMPLE.shortTripMiles,
  };
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

/** Mileage-weighted all-in RPM: total dollars / total miles. */
export function averageRpm(quotes) {
  let dollars = 0, miles = 0;
  for (const q of quotes) {
    dollars += q.rate;
    miles += q.loaded + q.deadhead;
  }
  return miles > 0 ? dollars / miles : null;
}

/** Group lanes by 3-digit ZIP area, the same granularity DAT uses. */
export function laneKey(pickup, dropoff) {
  return `${pickup.slice(0, 3)}-${dropoff.slice(0, 3)}`;
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
