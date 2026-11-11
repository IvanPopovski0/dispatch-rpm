import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.matchMedia = () => ({ matches: true });  // fx.js reads it on import
const { api, counterMessage, createSettingsSaver } = await import('../dispatch_rpm/static/common.js');

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
async function until(check) {
  for (let i = 0; i < 100 && !check(); i++) await settle();
}
const json = (status, body) => new Response(JSON.stringify(body), { status });
const offline = () => new TypeError('fetch failed');

/** Stub fetch with a queue of responses (or errors to throw) and record each request body. */
function stubFetch(...responses) {
  const bodies = [];
  globalThis.fetch = async (path, init) => {
    bodies.push(init.body ? JSON.parse(init.body) : null);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  };
  return bodies;
}

/** A saver that records what it saved and what was refused. */
function recordingSaver(options = {}) {
  const saved = [];
  const rejected = [];
  const saver = createSettingsSaver({
    onSaved: (changes) => saved.push(changes),
    onRejected: (key, why) => rejected.push([key, why]),
    delay: 0,
    retryDelays: [0, 0],
    ...options,
  });
  return { saver, saved, rejected };
}

test('api errors carry the HTTP status and the server message', async () => {
  stubFetch(json(404, { error: 'quote not found' }));
  await assert.rejects(api('/api/quotes/1', { method: 'DELETE' }), { status: 404, message: 'quote not found' });

  stubFetch(offline());
  await assert.rejects(api('/api/state'), (err) => err.status === undefined && err.message === 'Lost connection to the app');
});

test('a rejected setting is reported once and does not block valid changes after it', async () => {
  const { saver, saved, rejected } = recordingSaver();
  const bodies = stubFetch(json(400, { error: 'bad value for target' }), json(200, {}), json(200, {}));

  saver.queue('target', 'x'.repeat(70));
  await settle();
  saver.queue('equipment', 'reefer');
  await settle();
  saver.queue('target', '2.75');
  await settle();

  assert.deepEqual(bodies, [{ target: 'x'.repeat(70) }, { equipment: 'reefer' }, { target: '2.75' }]);
  assert.deepEqual(rejected, [['target', 'bad value for target']]);
  assert.deepEqual(saved, [{ equipment: 'reefer' }, { target: '2.75' }]);
});

test('a rejected value does not take valid changes from the same batch down with it', async () => {
  const { saver, saved, rejected } = recordingSaver({ delay: 5 });
  const bodies = stubFetch(
    json(400, { error: 'bad value for speed' }),  // the whole batch
    json(400, { error: 'bad value for speed' }),  // speed alone
    json(200, {}),                                // equipment alone
  );

  saver.queue('speed', 'x'.repeat(70));
  saver.queue('equipment', 'flatbed');
  await settle();

  assert.deepEqual(bodies, [{ speed: 'x'.repeat(70), equipment: 'flatbed' }, { speed: 'x'.repeat(70) }, { equipment: 'flatbed' }]);
  assert.deepEqual(rejected, [['speed', 'bad value for speed']]);
  assert.deepEqual(saved, [{ equipment: 'flatbed' }]);
});

test('a lost connection is retried on its own, a few times, then waits for the next change', async () => {
  const { saver, saved, rejected } = recordingSaver();
  const bodies = stubFetch(offline(), offline(), offline(), json(200, {}));

  saver.queue('ui_mode', 'advanced');
  await until(() => bodies.length >= 3);
  assert.equal(bodies.length, 3, 'first try + 2 retries');
  assert.deepEqual(saved, []);
  await settle();
  await settle();
  assert.equal(bodies.length, 3, 'no endless retries');

  saver.queue('equipment', 'van');
  await settle();
  assert.deepEqual(bodies[3], { ui_mode: 'advanced', equipment: 'van' });
  assert.deepEqual(saved, [{ ui_mode: 'advanced', equipment: 'van' }]);
  assert.deepEqual(rejected, []);
});

test('a server error is retried, not treated as a rejected value', async () => {
  const { saver, saved, rejected } = recordingSaver();
  stubFetch(json(500, { error: 'internal error' }), json(200, {}));

  saver.queue('effects', 'off');
  await settle();

  assert.deepEqual(rejected, []);
  assert.deepEqual(saved, [{ effects: 'off' }]);
});

test('saves go one at a time, in order, and a retry keeps the newer value', async () => {
  const { saver, saved } = recordingSaver({ retryDelays: [] });
  let release;
  const bodies = stubFetch(
    () => new Promise((resolve) => { release = () => resolve(json(200, {})); }),
    json(200, {}),
  );

  saver.queue('target', '2.50');
  await settle();
  saver.queue('target', '2.60');
  await settle();
  assert.equal(bodies.length, 1, 'the second save waits for the first');

  release();
  await settle();
  assert.deepEqual(bodies, [{ target: '2.50' }, { target: '2.60' }]);
  assert.deepEqual(saved, [{ target: '2.50' }, { target: '2.60' }]);

  stubFetch(offline(), json(200, {}));
  saver.queue('floor', '2.00');
  await settle();
  saver.queue('floor', '2.10');
  await settle();
  assert.deepEqual(saved.at(-1), { floor: '2.10' });
});

test('counterMessage: short and polite, asks without promising', () => {
  assert.equal(counterMessage({ from: 'Atlanta, GA', to: 'Chicago, IL', miles: 716.4, amount: 2275 }),
    'Thanks for the load. For Atlanta, GA → Chicago, IL (716 loaded mi), I can do $2,275 all-in. Let me know if that works.');
  assert.match(counterMessage({ from: 'A', to: 'B', stops: 2, miles: 1101, amount: 3200.5 }),
    /^Thanks for the load\. For A → B with 2 stops \(1,101 loaded mi\), I can do \$3,200\.50 all-in\./);
});
