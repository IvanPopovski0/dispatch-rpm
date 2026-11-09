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
    market: { active: { van: { value: 3, source: 'builtin', as_of: '2026-10-30' } }, company: {} },
    load: { values: { truck: '', pickup: '30318', dropoff: '60601', rate: '2300' }, current: () => cur },
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
        ...state,
      };
      view.render();
    },
    title: () => nodes['#s-answer'].childNodes[0].textContent,
    answer: () => nodes['#s-answer'].textContent,
    facts: () => nodes['#s-facts'].children.map((t) => t.textContent),
  };
}

test('Simple: previous trip facts clear while new miles are looked up', () => {
  const view = mount();
  view.render({});
  assert.equal(view.facts().length, 3);
  assert.match(view.title(), /Take it/);

  view.render({ zips: { truck: null, pickup: '30318', dropoff: '37203' }, loaded: null, pending: true });
  assert.equal(view.title(), 'Finding the miles…');
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
