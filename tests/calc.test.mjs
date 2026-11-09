import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SIMPLE, averageRpm, daysOld, driveTime, evaluate, implausibleOffer, laneKey, money, normalizeZip,
  parseNumber, periodAverages, roundUp, shortDate, simpleAdvice, tripFacts,
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
  assert.equal(book.askRate, null);

  const neg = evaluate({ ...base, rate: 2300 });
  assert.equal(neg.verdict, 'negotiate');
  assert.equal(neg.askRate, Math.ceil(2.5 * 1018));
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
  assert.equal(r.askRate, 3070, 'asks for market when market beats target');
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
