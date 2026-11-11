import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ASK, LANE_HISTORY, SIMPLE, averageRpm, compareRate, laneHistory, daysOld, driveTime, evaluate, implausibleOffer, laneKey, money, normalizeZip,
  SCHEDULE, parseNumber, periodAverages, placeZone, roundUp, scheduleCheck, shortDate, simpleAdvice, tripEstimate,
  tripFacts, zonedTime,
} from '../dispatch_rpm/static/calc.js';

test('parseNumber accepts what people type', () => {
  assert.equal(parseNumber('2600'), 2600);
  assert.equal(parseNumber('$2,600.50'), 2600.5);
  assert.equal(parseNumber(' 2.5 '), 2.5);
  assert.equal(parseNumber('.5'), 0.5);
  assert.equal(parseNumber('0'), 0);
  for (const bad of ['', '  ', 'abc', '1.2.3', '-5', '12a', null, undefined]) {
    assert.equal(parseNumber(bad), null, `expected null for ${bad}`);
  }
});

test('normalizeZip', () => {
  assert.equal(normalizeZip('60601'), '60601');
  assert.equal(normalizeZip(' 60601-1234 '), '60601');
  for (const bad of ['6060', '606011', '6060a', '', null]) assert.equal(normalizeZip(bad), null);
});

test('money and driveTime', () => {
  assert.equal(money(2600), '$2,600.00');
  assert.equal(money(2600.4, false), '$2,600');
  assert.equal(driveTime(968, 55), '17h 36m');
  assert.equal(driveTime(0, 55), '0h 00m');
  assert.equal(driveTime(100, 0), '—');
});

test('evaluate: book / negotiate / drop', () => {
  const base = { loaded: 968, deadhead: 50, target: 2.5, floor: 2.0 };

  const book = evaluate({ ...base, rate: 2600 });
  assert.equal(book.verdict, 'book');
  assert.equal(book.totalMiles, 1018);
  assert.equal(book.allIn.toFixed(2), '2.55');
  assert.equal(book.loadedRpm.toFixed(2), '2.69');
  assert.equal(book.openingRate, 2675, 'the opening ask is there for every verdict');

  const neg = evaluate({ ...base, rate: 2300 });
  assert.equal(neg.verdict, 'negotiate');
  assert.equal(neg.targetRate, Math.ceil(2.5 * 1018));
  assert.equal(neg.openingRate, 2675, '5% over the $2,545 target, rounded up to $25');
  assert.equal(neg.floorRate, Math.ceil(2.0 * 1018));

  const drop = evaluate({ ...base, rate: 1500 });
  assert.equal(drop.verdict, 'drop');
});

test('evaluate: exact threshold books', () => {
  assert.equal(evaluate({ loaded: 1000, rate: 2500, target: 2.5, floor: 2 }).verdict, 'book');
  assert.equal(evaluate({ loaded: 1000, rate: 2000, target: 2.5, floor: 2 }).verdict, 'negotiate');
});

test('evaluate: dollar thresholds ignore floating-point noise', () => {
  // 2.2 * 800 is 1760.0000000000002 in floating point
  const r = evaluate({ loaded: 800, rate: 1760, target: 2.2, floor: 2.2 });
  assert.equal(r.verdict, 'book');
  assert.equal(r.targetRate, 1760);
  assert.equal(r.floorRate, 1760);
  assert.equal(evaluate({ loaded: 800, rate: 1744, target: 2.18, floor: 2 }).targetRate, 1744);
  // a real fraction of a dollar still rounds up
  assert.equal(evaluate({ loaded: 801, rate: 1000, target: 2.2, floor: 2 }).targetRate, 1763);
});

test('evaluate: market comparison and ask', () => {
  const r = evaluate({ loaded: 1000, deadhead: 0, rate: 2300, target: 2.5, floor: 2, market: 3.07 });
  assert.equal(r.marketRate, 3070);
  assert.equal(r.marketDiff.toFixed(2), '-0.77');
  assert.equal(r.openingRate, 3225, 'opens 5% over the reference when it beats the target');
  // 2.01 * 350 is 703.4999999999999 in floating point; the reference rate is $703.50, rounded up
  assert.equal(evaluate({ loaded: 350, rate: 700, target: 2, floor: 1.5, market: 2.01 }).marketRate, 704);
});

test('evaluate: missing input and bad settings', () => {
  assert.equal(evaluate({ loaded: 0, rate: 2000, target: 2.5, floor: 2 }), null);
  assert.equal(evaluate({ loaded: 900, rate: null, target: 2.5, floor: 2 }), null);
  assert.equal(evaluate({ loaded: 900, rate: 2000, target: null, floor: 2 }), null);
  // walk-away above target collapses to target
  assert.equal(evaluate({ loaded: 1000, rate: 2400, target: 2.5, floor: 3 }).verdict, 'drop');
  // negative deadhead treated as zero
  assert.equal(evaluate({ loaded: 1000, deadhead: -50, rate: 2500, target: 2.5, floor: 2 }).totalMiles, 1000);
});

test('averages are weighted by miles', () => {
  const quotes = [
    { rate: 1000, loaded: 500, deadhead: 0 },   // $2.00
    { rate: 3000, loaded: 900, deadhead: 100 }, // $3.00
  ];
  assert.equal(averageRpm(quotes), 4000 / 1500);
  assert.equal(averageRpm([]), null);
});

test('periodAverages splits by day/week/month and equipment', () => {
  const now = new Date(2026, 10, 6, 12, 0).getTime();
  const at = (daysAgo) => (now - daysAgo * 86_400_000) / 1000;
  const quotes = [
    { equipment: 'van', created: at(0), rate: 2000, loaded: 1000, deadhead: 0 },
    { equipment: 'van', created: at(3), rate: 3000, loaded: 1000, deadhead: 0 },
    { equipment: 'van', created: at(20), rate: 4000, loaded: 1000, deadhead: 0 },
    { equipment: 'reefer', created: at(0), rate: 9000, loaded: 1000, deadhead: 0 },
  ];
  const [today, week, month] = periodAverages(quotes, 'van', now);
  assert.deepEqual([today.count, week.count, month.count], [1, 2, 3]);
  assert.equal(today.rpm, 2);
  assert.equal(week.rpm, 2.5);
  assert.equal(month.rpm, 3);
});

test('laneKey uses 3-digit ZIP areas', () => {
  assert.equal(laneKey('60601', '75201'), '606-752');
  assert.equal(laneKey('60699', '75299'), laneKey('60601', '75201'));
});

test('daysOld counts local calendar days', () => {
  const now = new Date(2026, 10, 6, 0, 30).getTime(); // just after local midnight
  assert.equal(daysOld('2026-11-06', now), 0);
  assert.equal(daysOld('2026-10-30', now), 7);
  assert.equal(daysOld('garbage', now), null);
  assert.equal(daysOld('', now), null);
});

test('simpleAdvice uses the market average as the target', () => {
  const market = 3.0;

  const take = simpleAdvice({ loaded: 1000, deadhead: 0, rate: 3100, market });
  assert.equal(take.verdict, 'book');

  // 1000 + 100 empty miles at $3.00 average -> target $3,300, counter 5% higher, rounded to $25
  const ask = simpleAdvice({ loaded: 1000, deadhead: 100, rate: 3000, market });
  assert.equal(ask.verdict, 'negotiate');
  assert.equal(ask.ask, roundUp(3300 * 1.05, 25));
  assert.equal(ask.ask % 25, 0);

  const pass = simpleAdvice({ loaded: 1000, deadhead: 100, rate: 2000, market });
  assert.equal(pass.verdict, 'drop');
  assert.equal(pass.minimum, roundUp(Math.ceil(3300 * 0.85), 25));
  assert.ok(pass.minimum > 2000);

  assert.equal(simpleAdvice({ loaded: 1000, rate: 2000, market: null }), null);
  assert.equal(simpleAdvice({ loaded: 0, rate: 2000, market }), null);
});

test('simpleAdvice short trips', () => {
  assert.equal(simpleAdvice({ loaded: 120, rate: 600, market: 3 }).shortTrip, true);
  assert.equal(simpleAdvice({ loaded: 1300, rate: 4000, market: 3 }).shortTrip, false);
});

test('tripFacts: miles, pay per mile and driving days from the SIMPLE constants', () => {
  const long = tripFacts({ loaded: 1200, deadhead: 100, rate: 3900 }); // 23.6 h of driving
  assert.equal(long.totalMiles, 1300);
  assert.equal(long.perMile, 3);
  assert.equal(long.hours, 1300 / SIMPLE.mph);
  assert.equal(long.days, 3);
  assert.equal(tripFacts({ loaded: 120, rate: 600 }).days, 1);

  const fullDay = SIMPLE.mph * SIMPLE.driveHoursPerDay;
  assert.equal(tripFacts({ loaded: fullDay }).days, 1);
  assert.equal(tripFacts({ loaded: fullDay + 1 }).days, 2);
  assert.equal(tripFacts({ loaded: 500 }).perMile, null, 'no rate yet');
  assert.equal(tripFacts({ loaded: 500, deadhead: null }).totalMiles, 500, 'empty miles unknown');
});

test('tripFacts: no loaded miles gives no facts instead of Infinity', () => {
  assert.equal(tripFacts({ loaded: 0, rate: 2000 }), null);           // same pickup and delivery ZIP
  assert.equal(tripFacts({ loaded: 0, deadhead: 40, rate: 2000 }), null);
  assert.equal(tripFacts({ loaded: null, rate: 2000 }), null);        // still looking up
  assert.equal(simpleAdvice({ loaded: 0, deadhead: 40, rate: 2000, market: 3 }), null);
});

test('simpleAdvice minimum does not jump a step on floating-point noise', () => {
  // $3.20 average -> walk away under $2.72/mi; 625 miles at $2.72 is exactly $1,700
  const a = simpleAdvice({ loaded: 625, rate: 1500, market: 3.2 });
  assert.equal(a.floorRate, 1700);
  assert.equal(a.minimum, 1700);
  // a real fraction of a cent still rounds up: 1401 miles at $1.3005 is $1,822.0005
  assert.equal(simpleAdvice({ loaded: 1401, rate: 1000, market: 1.53 }).floorRate, 1823);
});

test('shortDate', () => {
  assert.equal(shortDate('2026-11-02'), 'Nov 2');
  assert.equal(shortDate(''), '');
});

test('implausibleOffer catches an extra zero', () => {
  // $21,000 for 719 miles against a $3.07 average: almost certainly $2,100
  const typo = implausibleOffer({ rate: 21000, totalMiles: 719, market: 3.07 });
  assert.ok(typo);
  assert.equal(Math.round(typo.times), 10);
  assert.equal(typo.suggestion, 2100);
  // a strong but real offer is fine
  assert.equal(implausibleOffer({ rate: 2600, totalMiles: 719, market: 3.07 }), null);
  // short trips get more room: $600 for 120 miles is $5/mi, normal for a short haul
  assert.equal(implausibleOffer({ rate: 600, totalMiles: 120, market: 3.07 }), null);
  // far too high, but /10 isn't sensible either -> no suggestion
  assert.equal(implausibleOffer({ rate: 99999, totalMiles: 300, market: 3.07 }).suggestion, null);
  assert.equal(implausibleOffer({ rate: 2000, totalMiles: 0, market: 3.07 }), null);
});

test('compareRate: bands at the opening ask, target and walk-away', () => {
  const r = evaluate({ loaded: 968, deadhead: 50, rate: 2300, target: 2.5, floor: 2 });
  assert.deepEqual([r.floorRate, r.targetRate, r.openingRate], [2036, 2545, 2675]);
  const band = (amount) => compareRate(amount, r).band;
  assert.deepEqual([2675, 2674, 2545, 2544, 2036, 2035].map(band),
    ['opening', 'acceptable', 'acceptable', 'low', 'low', 'below']);

  const offer = compareRate(2300, r);
  assert.equal(offer.allIn.toFixed(2), (2300 / 1018).toFixed(2));
  assert.equal(offer.loadedRpm.toFixed(2), (2300 / 968).toFixed(2));
  assert.equal(offer.vsTarget, -245);
  assert.equal(compareRate(0, r), null);
  assert.equal(compareRate(2300, null), null);
});

test('simpleAdvice asks the same as before the opening ask was shared', () => {
  for (const [loaded, deadhead, market] of [[968, 50, 2.5], [120, 0, 3.07], [1401, 75, 1.53], [716, 6, 3.07]]) {
    const r = evaluate({ loaded, deadhead, rate: 1000, target: market, floor: market * SIMPLE.walkAwayShare, market });
    const before = roundUp(r.targetRate * ASK.markup, ASK.roundTo);
    assert.equal(simpleAdvice({ loaded, deadhead, rate: 1000, market }).ask, before, `${loaded} mi at ${market}`);
  }
});

test('laneHistory: booked loads only, same truck type and direction, recent, enough of them', () => {
  const now = Date.UTC(2026, 10, 10, 12);
  const day = 86_400;
  const quote = (extra) => ({
    created: now / 1000 - 2 * day, pickup: '30318', dropoff: '60601', equipment: 'van', loaded: 700, deadhead: 10,
    rate: 2000, stops: [], status: 'booked', final_rate: null, extras: 0, ...extra,
  });
  const lane = { pickup: '30303', dropoff: '60605', equipment: 'van', now };  // same 3-digit areas

  // two booked loads aren't enough to average
  let h = laneHistory([quote({}), quote({ created: now / 1000 - 5 * day })], lane);
  assert.deepEqual(h.booked, { count: 2, rpm: null, newestDays: 2, oldestDays: 5 });

  const quotes = [
    quote({ final_rate: 2100 }),                            // the agreed rate counts, not the first offer
    quote({ final_rate: 2000, extras: 100 }),               // plus broker-paid stop-off
    quote({ rate: 2100, loaded: 800, created: now / 1000 }),
    quote({ status: 'quoted', rate: 1400 }),                // offers are kept apart
    quote({ status: 'passed', rate: 1500 }),
    quote({ status: 'quoted', rate: 1600 }),
    quote({ equipment: 'reefer', rate: 9000 }),             // other truck type
    quote({ pickup: '60601', dropoff: '30318', rate: 9000 }),  // other direction
    quote({ stops: [{ zip: '37203', kind: 'drop' }], rate: 9000 }),  // multi-stop isn't comparable
    quote({ created: now / 1000 - (LANE_HISTORY.days + 1) * day, rate: 9000 }),  // too old
  ];
  h = laneHistory(quotes, lane);
  assert.equal(h.key, '303-606');
  assert.equal(h.booked.count, 3);
  assert.equal(h.booked.rpm.toFixed(4), ((2100 + 2100 + 2100) / (700 + 700 + 800)).toFixed(4));
  assert.deepEqual([h.booked.newestDays, h.booked.oldestDays], [0, 2]);
  assert.equal(h.offers.count, 3);
  assert.equal(h.offers.rpm.toFixed(4), ((1400 + 1500 + 1600) / 2100).toFixed(4));
  assert.equal(laneHistory(quotes, { ...lane, pickup: null }), null);
});

test('tripEstimate: only the costs you set, fuel never counted twice', () => {
  const base = { totalMiles: 1000, pay: 3000 };
  assert.equal(tripEstimate(base), null, 'nothing set, nothing estimated');

  const fuel = tripEstimate({ ...base, mpg: 6.5, fuelPrice: 3.9 });
  assert.equal(fuel.fuel.toFixed(2), (1000 / 6.5 * 3.9).toFixed(2));
  assert.deepEqual(fuel.missing, ['operating cost per mile']);
  assert.equal(fuel.left.toFixed(2), (3000 - 600).toFixed(2));

  const both = tripEstimate({ ...base, mpg: 6.5, fuelPrice: 3.9, costPerMile: 1.2, tolls: 40, lumper: 150 });
  assert.equal(both.expenses.toFixed(2), (600 + 1200 + 40 + 150).toFixed(2));
  assert.equal(both.margin.toFixed(4), ((3000 - 1990) / 3000).toFixed(4));
  assert.deepEqual(both.missing, []);

  // cost per mile that already covers fuel: fuel is not added again
  const included = tripEstimate({ ...base, mpg: 6.5, fuelPrice: 3.9, costPerMile: 1.8, costIncludesFuel: true });
  assert.deepEqual([included.fuel, included.fuelIncluded, included.expenses], [null, true, 1800]);

  assert.deepEqual(tripEstimate({ ...base, costPerMile: 1.2 }).missing, ['MPG for fuel']);
  assert.deepEqual(tripEstimate({ ...base, costPerMile: 1.2, mpg: 6.5 }).missing, ['diesel price']);
  assert.deepEqual(tripEstimate({ ...base, tolls: 40 }).missing, ['operating cost per mile', 'MPG for fuel']);
  assert.equal(tripEstimate({ ...base, pay: 0, tolls: 40 }), null);
});

test('averageRpm counts stop-off pay with the offer', () => {
  assert.equal(averageRpm([{ rate: 2000, extras: 100, loaded: 690, deadhead: 10 }]), 3);
});

test('zonedTime and placeZone: appointment clock times in the stop\'s own time zone', () => {
  const iso = (local, zone) => new Date(zonedTime(local, zone)).toISOString();
  assert.equal(iso('2026-11-10T08:00', 'America/New_York'), '2026-11-10T13:00:00.000Z');  // EST
  assert.equal(iso('2026-07-10T08:00', 'America/Chicago'), '2026-07-10T13:00:00.000Z');   // CDT
  assert.equal(iso('2026-03-08T03:30', 'America/New_York'), '2026-03-08T07:30:00.000Z');  // the day clocks go forward
  assert.equal(iso('2026-07-10T08:00', 'America/Phoenix'), '2026-07-10T15:00:00.000Z');   // Arizona keeps standard time
  assert.equal(zonedTime('', 'America/Chicago'), null);
  assert.deepEqual(placeZone('Atlanta, GA'), { zone: 'America/New_York', state: 'GA', split: false });
  assert.equal(placeZone('El Paso, TX').split, true);
  assert.equal(placeZone('Somewhere'), null);
});

test('scheduleCheck: window against loading, driving, breaks and unloading', () => {
  const h = 3_600_000;
  const at = (hours) => Date.UTC(2026, 10, 10) + hours * h;
  const check = (windowHours, miles, extra = {}) => scheduleCheck({ pickupAt: at(0), deliverAt: at(windowHours), loadedMiles: miles, mph: 55, ...extra });

  // 605 mi at 55 mph is exactly 11 h, so no break; one mile more needs a 10 h break
  assert.equal(check(30, 605).restHours, 0);
  assert.equal(check(30, 606).restHours, SCHEDULE.restHours);
  // 2 h loading + 11 h + 2 h unloading = 15 h
  assert.equal(check(17, 605).status, 'ok');      // exactly 2 h spare
  assert.equal(check(16.9, 605).status, 'tight');
  assert.equal(check(14.9, 605).status, 'too-tight');
  assert.equal(check(-1, 605).status, 'invalid');
  assert.equal(check(15, 605, { loadHours: 0, unloadHours: 0 }).spare, 4);
  assert.equal(check(17, 605, { loadHours: null, unloadHours: null }).loadHours, 2, 'blank means the 2 h default, not 0');
  assert.equal(scheduleCheck({ pickupAt: null, deliverAt: at(5), loadedMiles: 100, mph: 55 }), null);

  // Atlanta 8:00 Eastern to Chicago 18:00 Central is 11 h, not 10
  const crossing = scheduleCheck({
    pickupAt: zonedTime('2026-11-10T08:00', 'America/New_York'), deliverAt: zonedTime('2026-11-10T18:00', 'America/Chicago'),
    loadedMiles: 400, mph: 55,
  });
  assert.equal(crossing.windowHours, 11);
});
