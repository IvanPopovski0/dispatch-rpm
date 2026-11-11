import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.matchMedia = () => ({ matches: true });  // fx.js reads it on import
const { createLoad } = await import('../dispatch_rpm/static/load.js');

const PLACES = { 30303: 'Atlanta, GA', 30318: 'Atlanta, GA', 60601: 'Chicago, IL', 37203: 'Nashville, TN', 35203: 'Birmingham, AL' };
const MILES = {
  '30318-60601': 716, '30303-30318': 6, '30318-30318': 0,
  '30318-37203': 248, '37203-35203': 191, '35203-60601': 662,
};

globalThis.fetch = async (path) => {
  const url = new URL(path, 'http://app');
  const body = url.pathname === '/api/place'
    ? { zip: url.searchParams.get('zip'), name: PLACES[url.searchParams.get('zip')] }
    : { pickup: PLACES[url.searchParams.get('from')], dropoff: PLACES[url.searchParams.get('to')],
      miles: MILES[`${url.searchParams.get('from')}-${url.searchParams.get('to')}`], source: 'road' };
  return new Response(JSON.stringify(body), { status: 200 });
};

const lookups = () => new Promise((resolve) => setTimeout(resolve, 400));  // past the 280 ms debounce

test('current() reports lookups in progress, then the looked-up miles', async () => {
  const load = createLoad(() => {});
  load.set('truck', '30303');
  load.set('pickup', '30318');
  load.set('dropoff', '60601');

  let cur = load.current();
  assert.equal(cur.tripLoading, true);
  assert.equal(cur.pending, true);
  assert.equal(cur.emptyLookup, true);
  assert.equal(cur.places.pickup.status, 'loading');

  await lookups();
  cur = load.current();
  assert.equal(cur.tripLoading, false);
  assert.equal(cur.pending, false);
  assert.deepEqual(cur.places.pickup, { status: 'ok', data: { zip: '30318', name: 'Atlanta, GA' } });
  assert.equal(cur.loaded, 716);
  assert.equal(cur.deadheadAuto, 6);
  assert.equal(cur.deadhead, 6);
});

test('current(): no empty-miles lookup when the truck is at the pickup', async () => {
  const load = createLoad(() => {});
  load.set('truck', '30318');
  load.set('pickup', '30318');
  load.set('dropoff', '60601');
  await lookups();
  const cur = load.current();
  assert.equal(cur.emptyLookup, false);
  assert.equal(cur.deadhead, 0);
  assert.equal(cur.places.truck.status, 'ok');
  assert.equal(cur.places.dropoff.status, 'ok');
});

test('typed miles win over looked-up ones, and clear() keeps the truck', async () => {
  const load = createLoad(() => {});
  load.set('pickup', '30318');
  load.set('dropoff', '60601');
  load.set('truck', '30303');
  load.set('loaded', '700');
  await lookups();
  assert.equal(load.current().loaded, 700);
  assert.equal(load.current().loadedAuto, 716);

  load.clear();
  assert.equal(load.values.truck, '30303');
  assert.deepEqual(load.current().places.pickup, { status: 'idle' });
});

test('same pickup and delivery ZIP comes back as 0 loaded miles, not a lookup in progress', async () => {
  const load = createLoad(() => {});
  load.set('pickup', '30318');
  load.set('dropoff', '30318');
  await lookups();
  const cur = load.current();
  assert.ok(!cur.pending);
  assert.equal(cur.loaded, 0);
  assert.equal(cur.tripError, null);
});

test('a new delivery ZIP drops the old miles while the new ones are looked up', async () => {
  const load = createLoad(() => {});
  load.set('pickup', '30318');
  load.set('dropoff', '60601');
  await lookups();
  assert.equal(load.current().loaded, 716);

  load.set('dropoff', '30318');
  const cur = load.current();
  assert.equal(cur.pending, true);
  assert.equal(cur.tripLoading, true);
  assert.equal(cur.loaded, null);
  assert.equal(cur.route, null);
});

test('LTL: miles follow every stop in drive order, and each pickup adds its rate', async () => {
  const load = createLoad(() => {});
  load.set('pickup', '30318');
  load.set('dropoff', '60601');
  load.set('rate', '1500');
  load.setLtl(true);
  load.addStop('pickup');
  load.setStop(0, 'zip', '37203');
  load.addStop('drop');
  load.setStop(1, 'zip', '35203');

  let cur = load.current();
  assert.equal(cur.tripLoading, true);
  assert.equal(cur.partials, 2);
  assert.equal(cur.rate, null, 'the Nashville pickup has no rate yet');

  load.setStop(0, 'rate', '900');
  await lookups();
  cur = load.current();
  assert.equal(cur.loaded, 248 + 191 + 662);
  assert.deepEqual(cur.route, { pickup: 'Atlanta, GA', dropoff: 'Chicago, IL', miles: 1101, stops: 2 });
  assert.equal(cur.rate, 2400);
  assert.deepEqual(cur.stops.map((s) => [s.zip, s.kind, s.rate, s.place.data.name]),
    [['37203', 'pickup', 900, 'Nashville, TN'], ['35203', 'drop', null, 'Birmingham, AL']]);

  // a pickup turned into a drop no longer pays, and the miles don't change
  load.setStop(0, 'kind', 'drop');
  cur = load.current();
  assert.equal(cur.partials, 1);
  assert.equal(cur.rate, 1500);
  assert.equal(cur.loaded, 1101);
});

test('LTL: an empty stop holds the miles, and switching it off goes back to the direct route', async () => {
  const load = createLoad(() => {});
  load.set('pickup', '30318');
  load.set('dropoff', '60601');
  load.setLtl(true);
  load.addStop();
  let cur = load.current();
  assert.equal(cur.stopsIncomplete, true);
  assert.equal(cur.loaded, null);
  assert.equal(cur.tripLoading, false);

  load.setLtl(false);
  await lookups();
  cur = load.current();
  assert.deepEqual([cur.stops, cur.stopsIncomplete, cur.loaded, cur.route.stops], [[], false, 716, 0]);
  assert.equal(load.stops.length, 1, 'the stop is kept in case it is switched back on');

  load.clear();
  assert.equal(load.ltl, false);
  assert.equal(load.stops.length, 0);
});

test('stop-off pay is added to the offer the verdict judges, and clears with the load', () => {
  const load = createLoad(() => {});
  load.set('rate', '2000');
  assert.deepEqual([load.current().rate, load.current().stopoff, load.current().pay], [2000, 0, 2000]);
  load.set('stopoff', '150');
  assert.deepEqual([load.current().rate, load.current().stopoff, load.current().pay], [2000, 150, 2150]);
  load.set('tolls', '40');
  load.clear();
  assert.deepEqual([load.values.stopoff, load.values.tolls, load.current().pay], ['', '', null]);
});
