import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.matchMedia = () => ({ matches: true });  // fx.js reads it on import
const { api, createSettingsSaver } = await import('../dispatch_rpm/static/common.js');

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const json = (status, body) => new Response(JSON.stringify(body), { status });

/** Stub fetch with a queue of responses (or errors to throw) and record each request body. */
function stubFetch(...responses) {
  const bodies = [];
  globalThis.fetch = async (path, init) => {
    bodies.push(init.body ? JSON.parse(init.body) : null);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return bodies;
}

test('api errors carry the HTTP status and the server message', async () => {
  stubFetch(json(404, { error: 'quote not found' }));
  await assert.rejects(api('/api/quotes/1', { method: 'DELETE' }), { status: 404, message: 'quote not found' });

  stubFetch(new TypeError('fetch failed'));
  await assert.rejects(api('/api/state'), (err) => err.status === undefined && err.message === 'Lost connection to the app');
});

test('settings saver drops a batch the server rejects', async () => {
  const saved = [];
  const bodies = stubFetch(json(400, { error: 'bad value for target' }), json(200, {}));
  const saver = createSettingsSaver((changes) => saved.push(changes), 0);

  saver.queue('target', 'x'.repeat(70));
  await settle();
  saver.queue('equipment', 'reefer');
  await settle();

  assert.deepEqual(bodies, [{ target: 'x'.repeat(70) }, { equipment: 'reefer' }]);
  assert.deepEqual(saved, [{ equipment: 'reefer' }]);
});

test('settings saver retries after a lost connection', async () => {
  const saved = [];
  const bodies = stubFetch(new TypeError('fetch failed'), json(200, {}));
  const saver = createSettingsSaver((changes) => saved.push(changes), 0);

  saver.queue('ui_mode', 'advanced');
  await settle();
  assert.deepEqual(saved, []);
  saver.queue('equipment', 'van');
  await settle();

  assert.deepEqual(bodies[1], { ui_mode: 'advanced', equipment: 'van' });
  assert.deepEqual(saved, [{ ui_mode: 'advanced', equipment: 'van' }]);
});
