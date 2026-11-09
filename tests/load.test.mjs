import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.matchMedia = () => ({ matches: true });  // fx.js reads it on import
const { createLoad } = await import('../dispatch_rpm/static/load.js');

const PLACES = { 30303: 'Atlanta, GA', 30318: 'Atlanta, GA', 60601: 'Chicago, IL' };
const MILES = { '30318-60601': 716, '30303-30318': 6, '30318-30318': 0 };

globalThis.fetch = async (path) => {
  const url = new URL(path, 'http://app');
  const body = url.pathname === '/api/place'
    ? { zip: url.searchParams.get('zip'), name: PLACES[url.searchParams.get('zip')] }
    : { pickup: 'A', dropoff: 'B', miles: MILES[`${url.searchParams.get('from')}-${url.searchParams.get('to')}`], source: 'road' };
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
