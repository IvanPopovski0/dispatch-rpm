import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FakeElement, fakeRoot } from './fake-dom.mjs';

const { createAdvancedView } = await import('../dispatch_rpm/static/advanced.js');

const ROUTE = { pickup: 'Atlanta, GA', dropoff: 'Chicago, IL', miles: 716, source: 'road' };
const EMPTY = { truck: null, pickup: null, dropoff: null };

function mount() {
  const root = fakeRoot({ '#a-verdict': Object.assign(new FakeElement('section'), { className: 'verdict glass' }) });
  let cur;
  const ctx = {
    settings: { equipment: 'van', target: '2.50', floor: '2.00', speed: '55' },
    market: { active: { van: { value: 3, source: 'builtin', as_of: '2026-10-30' } }, company: {} },
    quotes: [],
    flash: false,
    load: { values: { truck: '', pickup: '', dropoff: '', loaded: '', deadhead: '', rate: '' }, current: () => cur },
    edit() {},
    setSetting() {},
    render() {},
    clearLoad() {},
    flashStatus(show) {
      ctx.flash = true;
      show();
    },
  };
  const view = createAdvancedView(root, ctx);
  return {
    ctx,
    view,
    render(state) {
      cur = {
        zips: { truck: null, pickup: '30318', dropoff: '60601' },
        route: ROUTE, tripError: null, tripLoading: false, loaded: 716, loadedAuto: 716, loadedTyped: false,
        deadhead: 0, deadheadAuto: null, emptyLookup: false, emptyError: null, estimated: false, rate: 2300,
        ...state,
      };
      view.render();
    },
    status: () => [root.nodes['#a-status'].textContent, root.nodes['#a-status'].className],
  };
}

/** Save the load with Enter, as the dispatcher would; the server stores the quote. */
async function justSaved(a) {
  a.render({});
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: 1, created: Date.now() / 1000, pickup: '30318', dropoff: '60601', pickup_name: 'Atlanta, GA',
    dropoff_name: 'Chicago, IL', equipment: 'van', loaded: 716, deadhead: 0, rate: 2300,
  }), { status: 200 });
  a.view.onEnter();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(a.status(), ['Saved Atlanta, GA → Chicago, IL at $3.21 all-in.', 'status ']);
  assert.equal(a.ctx.quotes.length, 1);
}

test('Advanced: the save message stays while there is nothing new to say', async () => {
  const a = mount();
  await justSaved(a);
  a.render({ zips: EMPTY, route: null, loaded: null, rate: null });
  assert.deepEqual(a.status(), ['Saved Atlanta, GA → Chicago, IL at $3.21 all-in.', 'status ']);
});

test('Advanced: the next load\'s lookup and warnings replace the save message at once', async () => {
  const a = mount();
  await justSaved(a);
  a.render({ route: null, loaded: null, tripLoading: true });
  assert.equal(a.status()[0], 'Looking up miles…');

  a.render({ estimated: true });
  assert.deepEqual(a.status(), ['Atlanta, GA → Chicago, IL: 716 mi. ESTIMATE, the route server is busy, so double-check.', 'status warn']);

  // Once replaced, clearing the load doesn't bring an old line back.
  a.render({ zips: EMPTY, route: null, loaded: null });
  assert.deepEqual(a.status(), ['', 'status ']);
});

test('Advanced: errors show through the save message too', async () => {
  const a = mount();
  await justSaved(a);
  a.render({ route: null, loaded: null, tripError: 'No road route between these ZIP codes' });
  assert.deepEqual(a.status(), ['No road route between these ZIP codes. Type the miles in.', 'status error']);

  a.render({ emptyLookup: true, emptyError: "Can't reach the ZIP lookup service" });
  assert.equal(a.status()[1], 'status warn');
});
