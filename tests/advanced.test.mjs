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
    load: {
      values: { truck: '', pickup: '', dropoff: '', loaded: '', deadhead: '', rate: '', counter: '',
        broker: '', mc: '', notes: '', status: '', final: '', stopoff: '', detention: '', layover: '', tolls: '', lumper: '',
        pickup_at: '', deliver_at: '', load_h: '', unload_h: '' },
      stops: [], ltl: false, current: () => cur,
    },
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
        ltl: false, stops: [], stopsIncomplete: false, partials: 1, counter: null,
        places: { truck: { status: 'idle' }, pickup: { status: 'ok', data: { name: 'Atlanta, GA' } },
          dropoff: { status: 'ok', data: { name: 'Chicago, IL' } } },
        stopoff: 0,
        ...state,
      };
      cur.pay ??= cur.rate == null ? null : cur.rate + cur.stopoff;  // as load.js works it out
      view.render();
    },
    status: () => [root.nodes['#a-status'].textContent, root.nodes['#a-status'].className],
    verdictClass: () => root.nodes['#a-verdict'].className,
    node: (sel) => root.nodes[sel],
  };
}

/** Save the load with Enter, as the dispatcher would; the server stores the quote. */
async function justSaved(a) {
  a.render({});
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: 1, status: 'quoted', final_rate: null, broker: '', mc: '', notes: '', created: Date.now() / 1000, pickup: '30318', dropoff: '60601', pickup_name: 'Atlanta, GA',
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
  assert.equal(a.verdictClass(), 'verdict glass pending');

  a.render({ estimated: true });
  assert.deepEqual(a.status(), ['Atlanta, GA → Chicago, IL: 716 mi. ESTIMATE, the route server is busy, so double-check.', 'status warn']);

  // once replaced, clearing the load doesn't bring an old line back
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

test('Advanced: an LTL load saves its stops and maps them on the way', async () => {
  const a = mount();
  a.ctx.load.ltl = true;
  a.ctx.load.stops.push({ zip: '37203', kind: 'pickup', rate: '900' }, { zip: '35203', kind: 'drop', rate: '' });
  const stops = [
    { zip: '37203', kind: 'pickup', rate: 900, place: { status: 'ok', data: { name: 'Nashville, TN' } } },
    { zip: '35203', kind: 'drop', rate: null, place: { status: 'ok', data: { name: 'Birmingham, AL' } } },
  ];
  a.render({ ltl: true, stops, partials: 2, rate: 3200, loaded: 1101, route: { ...ROUTE, miles: 1101, stops: 2 } });
  assert.equal(a.status()[0], 'Atlanta, GA → 2 stops → Chicago, IL: 1,101 mi');
  assert.match(a.node('#a-gmaps').href, /&waypoints=37203%2C%20USA%7C35203%2C%20USA$/);
  assert.equal(a.node('[data-rate-label]').textContent, 'Pickup 1 rate $');

  let sent;
  globalThis.fetch = async (path, init) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ id: 2, status: 'quoted', final_rate: null, broker: '', mc: '', notes: '', created: Date.now() / 1000, ...sent, pickup_name: 'Atlanta, GA',
      dropoff_name: 'Chicago, IL', stops: [{ zip: '37203', kind: 'pickup', rate: 900 }, { zip: '35203', kind: 'drop' }] }),
    { status: 201 });
  };
  a.view.onEnter();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sent.rate, 3200);
  assert.deepEqual(sent.stops, [{ zip: '37203', kind: 'pickup', rate: 900 }, { zip: '35203', kind: 'drop' }]);
  assert.match(a.status()[0], /^Saved Atlanta, GA → Chicago, IL · 2 stops at \$2\.91 all-in\.$/);
});

test('Advanced: negotiation shows opening, acceptable and walk-away beside the offer and your counter', async () => {
  const a = mount();
  a.render({ rate: 1600 });  // 716 mi at $2.50 target / $2.00 walk-away, national avg $3.00
  const verdict = a.node('#a-verdict').textContent;
  assert.match(verdict, /Ask \$2,275/);
  assert.match(verdict, /Acceptable from \$1,790\. Don't go below \$1,432\./);
  assert.match(verdict, /vs \$3\.00 national avg/);

  const rows = () => a.node('#a-nego-table').querySelectorAll('tr').slice(1).map((tr) => tr.children.map((c) => c.textContent));
  assert.equal(a.node('#a-nego').hidden, false);
  assert.deepEqual(rows(), [
    ['Opening ask', '$2,275', '$3.18', '$3.18', '+$485'],
    ['Acceptable (target)', '$1,790', '$2.50', '$2.50', '—'],
    ['Walk-away', '$1,432', '$2.00', '$2.00', '−$358'],
    ['Broker offer', '$1,600', '$2.23', '$2.23', '−$190'],
  ]);
  assert.equal(a.node('#a-nego-note').textContent, 'The offer is under your target but above walk-away.');
  assert.match(a.node('#a-nego-message').textContent, /I can do \$2,275 all-in/);

  a.render({ rate: 1600, counter: 2000 });
  assert.deepEqual(rows().at(-1), ['Your counter', '$2,000', '$2.79', '$2.79', '+$210']);
  assert.match(a.node('#a-nego-note').textContent, /Your counter is acceptable \(at or above your target\), \+\$400 vs the offer\./);

  let copied = null;
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (t) => { copied = t; } } }, configurable: true });
  const copy = a.node('#a-nego').querySelector('button');
  await copy.fire('click');
  assert.equal(copied, 'Thanks for the load. For Atlanta, GA → Chicago, IL (716 loaded mi), I can do $2,000 all-in. Let me know if that works.');
  assert.equal(copy.textContent, 'Copied');

  // several pickups are paid by different brokers, so there's no single message to send
  a.render({ rate: 1600, partials: 2 });
  assert.equal(a.node("#a-nego").children.at(-1).hidden, true);
  assert.equal(a.node('#a-nego-message').textContent, '');

  a.render({ rate: null });
  assert.equal(a.node('#a-nego').hidden, true);
});

test('Advanced: a company rate is named as one, not as the market', () => {
  const a = mount();
  a.ctx.market.active.van.source = 'company';
  a.render({ rate: 1600 });
  assert.match(a.node('#a-verdict').textContent, /vs \$3\.00 company rate/);
  assert.ok(a.node('#a-stats').children.some((t) => t.textContent === '$2,148company rate × loaded mi'));
});

test('Advanced: broker, MC, notes and outcome are saved with the quote', async () => {
  const a = mount();
  Object.assign(a.ctx.load.values, { broker: 'Acme Logistics', mc: 'MC 123456', notes: 'needs TWIC', status: 'booked', final: '2,750' });
  a.render({ counter: 2900 });
  assert.equal(a.node('#a-final-label').hidden, false, 'the agreed rate shows for a booked load');
  assert.equal(a.node('#a-details-hint').textContent, 'Acme Logistics · Booked');

  let sent;
  globalThis.fetch = async (path, init) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ id: 3, created: Date.now() / 1000, ...sent, mc: '123456', extras: 0,
      pickup_name: 'Atlanta, GA', dropoff_name: 'Chicago, IL' }), { status: 201 });
  };
  a.view.onEnter();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual([sent.broker, sent.mc, sent.notes, sent.status, sent.final_rate, sent.counter],
    ['Acme Logistics', 'MC 123456', 'needs TWIC', 'booked', 2750, 2900]);
  assert.match(a.status()[0], /all-in, booked\.$/);
});

test('Advanced: a bad MC number stops the save', async () => {
  const a = mount();
  a.ctx.load.values.mc = 'ABC';
  a.render({});
  let called = false;
  globalThis.fetch = async () => { called = true; };
  a.view.onEnter();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(called, false);
  assert.deepEqual(a.status(), ['MC number is up to 8 digits, like MC 123456.', 'status error']);
});

test('Advanced: history filters by broker, offers earlier quotes, and records how a quote turned out', async () => {
  const a = mount();
  const quote = (id, broker, extra = {}) => ({
    id, created: Date.now() / 1000, pickup: '30318', dropoff: '60601', pickup_name: 'Atlanta, GA', dropoff_name: 'Chicago, IL',
    equipment: 'van', loaded: 716, deadhead: 0, rate: 1900, stops: [], status: 'quoted', final_rate: null, counter: null,
    extras: 0, broker, mc: '', notes: '', ...extra,
  });
  a.ctx.quotes.push(quote(1, 'Acme Logistics', { mc: '123456' }), quote(2, 'Blue Freight'));
  a.view.show();
  const rows = () => a.node('#a-history').querySelectorAll('tr').slice(1);
  assert.equal(rows().length, 2);

  a.ctx.load.values.broker = 'acme logistics';
  a.render({});
  assert.equal(a.node('#a-broker-hint').textContent, '1 earlier quote with acme logistics. Show them');

  const filter = a.node('#a-history-filter');
  filter.value = '123456';
  await filter.fire('input');
  assert.equal(rows().length, 1);
  assert.match(rows()[0].textContent, /Acme Logistics · MC 123456/);

  let sent;
  globalThis.fetch = async (path, init) => {
    sent = [path, JSON.parse(init.body)];
    return new Response(JSON.stringify({ ...a.ctx.quotes[0], status: 'booked', final_rate: null }), { status: 200 });
  };
  const status = rows()[0].querySelector('select');
  status.value = 'booked';
  await status.fire('change');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(sent, ['/api/quotes/1', { status: 'booked', final_rate: null, notes: '' }]);
  assert.equal(a.ctx.quotes[0].status, 'booked');
  assert.ok(rows()[0].querySelector('input'), 'a booked quote gets a box for the agreed rate');
});

test('Advanced: lane history compares the offer with your booked loads, or says there are too few', () => {
  const a = mount();
  const day = 86_400;
  const booked = (daysOld, rate) => ({
    id: daysOld, created: Date.now() / 1000 - daysOld * day, pickup: '30318', dropoff: '60601', equipment: 'van',
    loaded: 716, deadhead: 0, rate, stops: [], status: 'booked', final_rate: null, extras: 0, broker: '', mc: '', notes: '',
  });
  a.ctx.quotes.push(booked(3, 2148));
  a.render({ rate: 1600 });
  assert.equal(a.node('#a-lane-history').textContent,
    'Your lane history (ZIP areas 303 → 606, dry vans, last 90 days): not enough booked loads yet, 1 of 3.');

  a.ctx.quotes.push(booked(10, 2148), booked(20, 2148));
  a.render({ rate: 1600 });
  assert.equal(a.node('#a-lane-history').textContent,
    'Your booked loads (ZIP areas 303 → 606, dry vans, last 90 days): $3.00/mi loaded on average from 3, '
    + 'latest 3 days ago. This offer is $0.77/mi below that.');

  a.render({ rate: 1600, stops: [{ zip: '37203', kind: 'drop', rate: null, place: { status: 'idle' } }] });
  assert.match(a.node('#a-lane-history').textContent, /covers direct loads only/);
});

test('Advanced: trip costs appear only with your assumptions, and say what they leave out', () => {
  const a = mount();
  a.render({ rate: 1600 });
  assert.equal(a.node('#a-costs').hidden, true, 'no assumptions, no estimate');

  Object.assign(a.ctx.settings, { mpg: '6.5', cost_per_mile: '', fuel_price: '', cost_includes_fuel: '0' });
  a.ctx.market.diesel = { price: 3.9, week: '2026-11-09' };
  Object.assign(a.ctx.load.values, { tolls: '40', detention: '75' });
  a.render({ rate: 1600 });
  const rows = () => a.node('#a-costs-table').querySelectorAll('tr').map((tr) => tr.children.map((c) => c.textContent));
  assert.equal(a.node('#a-costs').hidden, false);
  assert.deepEqual(rows(), [
    ['Pay (offer)', '$1,600', ''],
    ['Fuel', '$430', '6.5 mpg at $3.90/gal (EIA weekly)'],
    ['Operating', '—', 'not set'],
    ['Tolls', '$40', ''],
    ['Costs entered', '$470', ''],
    ['Left after these costs', '$1,130', '71% of pay'],
  ]);
  assert.equal(a.node('#a-costs-note').textContent,
    'Not counted: operating cost per mile. Possible detention/layover pay of $75 isn’t counted until it’s paid.');

  Object.assign(a.ctx.settings, { cost_per_mile: '1.80', cost_includes_fuel: '1' });
  a.render({ rate: 1600 });
  assert.deepEqual(rows()[1], ['Fuel', '—', 'in cost per mile']);
});

test('Advanced: stop-off pay counts toward the verdict and is saved with the quote', async () => {
  const a = mount();
  a.ctx.load.values.stopoff = '150';
  a.render({ rate: 1600, stopoff: 150 });
  const offerRow = a.node('#a-nego-table').querySelectorAll('tr').find((tr) => /Broker offer/.test(tr.textContent));
  assert.equal(offerRow.children[0].textContent, 'Broker offer + stop-off');
  assert.equal(offerRow.children[1].textContent, '$1,750');

  let sent;
  globalThis.fetch = async (path, init) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ id: 9, created: Date.now() / 1000, ...sent, pickup_name: 'Atlanta, GA',
      dropoff_name: 'Chicago, IL' }), { status: 201 });
  };
  a.view.onEnter();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual([sent.rate, sent.extras], [1600, 150]);
});

test('Advanced: schedule check reads each time in its stop\'s zone and warns in the verdict when too tight', () => {
  const a = mount();
  Object.assign(a.ctx.load.values, { pickup_at: '2026-11-10T08:00', deliver_at: '2026-11-10T20:00' });
  a.render({ rate: 1600 });  // 716 mi at 55 mph: 2 h + 13 h + 10 h break + 2 h = 27 h, window 13 h (Eastern -> Central)
  assert.match(a.node('#a-schedule').textContent,
    /^Schedule looks too tight: about 27 h needed, 13 h between appointments\. 2 h loading \+ 13 h driving \+ 10 h of breaks \+ 2 h unloading\. Times read as Eastern → Central time\. Rough estimate: check driver availability and hours of service separately\.$/);
  assert.equal(a.node('#a-schedule').className, 'status error');
  assert.match(a.node('#a-verdict').textContent, /Schedule looks too tight/);

  a.ctx.load.values.deliver_at = '2026-11-11T14:00';
  a.render({ rate: 1600 });
  assert.match(a.node('#a-schedule').textContent, /^Schedule looks workable: about 4 h to spare\./);
  assert.doesNotMatch(a.node('#a-verdict').textContent, /Schedule/);

  a.ctx.load.values.deliver_at = '2026-11-09T14:00';
  a.render({ rate: 1600 });
  assert.match(a.node('#a-verdict').textContent, /Delivery is before pickup/);
});

test('Advanced: Copy quote copies one line with the numbers that matter', async () => {
  const a = mount();
  a.render({ rate: null });
  const copy = a.node('#a-actions').children.at(-1);
  assert.equal(copy.textContent, 'Copy quote');
  assert.equal(copy.hidden, true, 'nothing to copy until there is a verdict');

  a.render({ rate: 1600, deadhead: 6 });
  assert.equal(copy.hidden, false);
  let copied = null;
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (t) => { copied = t; } } }, configurable: true });
  await copy.fire('click');
  assert.equal(copied, 'Atlanta, GA → Chicago, IL · 716 loaded + 6 empty mi · offer $1,600 · $2.22/mi all-in, $2.23/mi loaded'
    + ' · Negotiate: ask $2,275, walk away under $1,444');
});
