import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SIMPLE, driveTime, tripFacts } from '../dispatch_rpm/static/calc.js';
import { FakeElement, fakeRoot } from './fake-dom.mjs';

const { createSimpleView } = await import('../dispatch_rpm/static/simple.js');

function mount() {
  const root = fakeRoot({ '#s-answer': Object.assign(new FakeElement('section'), { className: 'answer glass' }) });
  const { nodes } = root;
  let cur;
  const ctx = {
    settings: { equipment: 'van' },
    quotes: [],
    market: { active: { van: { value: 3, source: 'builtin', as_of: '2026-10-30' } }, company: {} },
    load: { values: { truck: '', pickup: '30318', dropoff: '60601', rate: '2300' }, stops: [], ltl: false, current: () => cur },
    edit() {},
    clearLoad() {},
  };
  const view = createSimpleView(root, ctx);
  return {
    render(state) {
      cur = {
        zips: { truck: null, pickup: '30318', dropoff: '60601' },
        places: { truck: { status: 'idle' }, pickup: { status: 'ok', data: { name: 'Atlanta, GA' } }, dropoff: { status: 'ok', data: { name: 'Chicago, IL' } } },
        rate: 2300, loaded: 716, deadhead: 0, pending: false, tripError: null, emptyError: null, estimated: false,
        ltl: false, stops: [], stopsIncomplete: false, partials: 1,
        stopoff: 0,
        ...state,
      };
      cur.pay ??= cur.rate == null ? null : cur.rate + cur.stopoff;  // as load.js works it out
      view.render();
    },
    title: () => nodes['#s-answer'].childNodes[0].textContent,
    answer: () => nodes['#s-answer'].textContent,
    facts: () => nodes['#s-facts'].children.map((t) => t.textContent),
    panel: () => nodes['#s-answer'],
    ctx,
    node: (sel) => nodes[sel],
    stopRows: () => nodes['[data-stops]'].querySelector('.stop-list').children,
  };
}

test('Simple: previous trip facts clear while new miles are looked up', () => {
  const view = mount();
  view.render({});
  assert.equal(view.facts().length, 3);
  assert.match(view.title(), /Take it/);

  view.render({ zips: { truck: null, pickup: '30318', dropoff: '37203' }, loaded: null, pending: true });
  assert.equal(view.title(), 'Finding the miles…');
  assert.equal(view.panel().className, 'answer glass pending');  // the loading shimmer, with no verdict icon
  assert.equal(view.panel().childNodes[0].children.length, 0);
  assert.deepEqual(view.facts(), []);
});

test('Simple: same pickup and delivery ZIP explains instead of crashing', () => {
  const view = mount();
  view.render({});
  view.render({ zips: { truck: null, pickup: '30318', dropoff: '30318' }, loaded: 0 });
  assert.equal(view.title(), 'No miles to measure');
  assert.match(view.answer(), /same ZIP code/);
  assert.match(view.answer(), /Advanced/);
  assert.deepEqual(view.facts(), []);

  // empty miles from the truck don't turn it into a priced trip
  view.render({ zips: { truck: '30303', pickup: '30318', dropoff: '30318' }, loaded: 0, deadhead: 6 });
  assert.equal(view.title(), 'No miles to measure');
  assert.doesNotMatch(view.answer() + view.facts().join(), /Infinity|NaN/);
});

test('Simple: no road route is an error with a way forward, not an estimate', () => {
  const view = mount();
  view.render({ tripError: 'No road route between these ZIP codes', loaded: null });
  assert.equal(view.title(), "Couldn't find the miles");
  assert.match(view.answer(), /No road route.*type the miles/);
  assert.doesNotMatch(view.answer(), /estimated|busy/);
  assert.deepEqual(view.facts(), []);
});

test('Simple: LTL stops show their city and rate, and the advice is for all pickups together', () => {
  const view = mount();
  view.ctx.load.ltl = true;
  view.ctx.load.stops.push({ zip: '37203', kind: 'pickup', rate: '900' });
  view.render({
    ltl: true, partials: 2, loaded: 1101, rate: 3000,
    stops: [{ zip: '37203', kind: 'pickup', rate: 900, place: { status: 'ok', data: { name: 'Nashville, TN' } } }],
  });
  const row = view.stopRows()[0];
  assert.equal(row.querySelector('[data-f="zip"]').value, '37203');
  assert.equal(row.querySelector('[data-f="rate"]').value, '900');
  assert.equal(row.querySelector('.found').textContent, '✓ Nashville, TN');
  assert.equal(view.title(), '↑Ask for more');
  assert.match(view.answer(), /Ask for \$3,475 in total/);
  assert.match(view.answer(), /\$475 more across the 2 pickups/);
  assert.equal(view.node('[data-rate-label]').textContent, 'What does the first pickup pay?');
  assert.equal(view.panel().querySelector('button'), null, 'no single message to copy for several brokers');

  view.render({ ltl: true, stopsIncomplete: true, stops: [{ zip: null, kind: 'drop', rate: null, place: { status: 'idle' } }] });
  assert.equal(view.title(), 'Fill in every stop');
  assert.deepEqual(view.facts(), []);
});

test('Simple: fact tiles show the shared trip calculation', () => {
  const view = mount();
  view.render({ loaded: 1200, deadhead: 100, rate: 3900 });
  const trip = tripFacts({ loaded: 1200, deadhead: 100, rate: 3900 });
  assert.deepEqual(view.facts(), [
    '1,300 mi1200 loaded + 100 empty',
    '$3.00/mipays per mile, all miles',
    `${driveTime(trip.totalMiles, SIMPLE.mph)}driving, about ${trip.days} days`,
  ]);
});

test('Simple: Copy message is offered with the counter', () => {
  const view = mount();
  view.render({ rate: 1900 });  // under the $3.00 average, above walk-away
  assert.match(view.title(), /Ask for more/);
  assert.equal(view.panel().querySelector('button').textContent, 'Copy message');
});

test('Simple: one line from your booked loads on this lane, only when there are enough', () => {
  const view = mount();
  const booked = (id) => ({
    id, created: Date.now() / 1000 - id * 86_400, pickup: '30318', dropoff: '60601', equipment: 'van', loaded: 716,
    deadhead: 0, rate: 2148, stops: [], status: 'booked', final_rate: null, extras: 0,
  });
  view.ctx.quotes.push(booked(1), booked(2));
  view.render({});
  assert.equal(view.node('#s-history').textContent, '');
  view.ctx.quotes.push(booked(4));
  view.render({});
  assert.equal(view.node('#s-history').textContent,
    'Your history: you booked this lane at $3.00/mi loaded (3 loads, latest 1 day ago).');
});

test('Simple: stop-off pay from Advanced is counted, and said so', () => {
  const view = mount();
  view.render({ rate: 1900, stopoff: 150 });
  assert.match(view.answer(), /Includes \$150 stop-off pay entered in Advanced\./);
  assert.match(view.answer(), /their \$2,050 with stop-off is still OK/);
});
