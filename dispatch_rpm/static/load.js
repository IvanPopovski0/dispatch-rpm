// The load being quoted, shared by Simple and Advanced so switching modes
// mid-call keeps everything you typed. Lookups (city names, miles) live here
// too, so each ZIP is looked up once no matter which view asked.

import { normalizeZip, parseNumber } from './calc.js';
import { api } from './common.js';

/** One server lookup that can be restarted; answers for an old key are dropped. */
class Lookup {
  constructor(onChange) {
    this.onChange = onChange;
    this.key = null;
    this.seq = 0;
    this.timer = 0;
    this.controller = null;
    this.state = { status: 'idle' };
  }

  set(key, url) {
    if (key === this.key) return;
    this.key = key;
    this.seq += 1;
    clearTimeout(this.timer);
    this.controller?.abort();
    if (!key) {
      this.state = { status: 'idle' };
      return;
    }
    this.state = { status: 'loading' };
    const seq = this.seq;
    this.timer = setTimeout(async () => {
      this.controller = new AbortController();
      try {
        const data = await api(url, { signal: this.controller.signal });
        if (seq === this.seq) this.finish({ status: 'ok', data });
      } catch (err) {
        if (seq === this.seq && err.name !== 'AbortError') this.finish({ status: 'error', error: err.message });
      }
    }, 280);
  }

  finish(state) {
    this.state = state;
    this.onChange();
  }
}

export const MAX_STOPS = 8;

export function createLoad(onChange) {
  const values = {
    truck: '', pickup: '', dropoff: '', rate: '', loaded: '', deadhead: '', counter: '',
    broker: '', mc: '', notes: '', status: '', final: '',  // optional details saved with the quote
    stopoff: '', detention: '', layover: '', tolls: '', lumper: '',  // optional money in and out
    pickup_at: '', deliver_at: '', load_h: '', unload_h: '',  // optional appointment times (local to each stop)
  };
  const places = { truck: new Lookup(onChange), pickup: new Lookup(onChange), dropoff: new Lookup(onChange) };
  // LTL / partial: stops between pickup and delivery, in drive order; each pickup has its own rate
  const stops = [];
  const stopPlaces = [];
  const legs = [];                     // pickup -> stops -> delivery, one lookup per leg
  const empty = new Lookup(onChange);  // truck -> pickup
  let ltl = false;
  let routeKey = null;

  function zips() {
    return {
      truck: normalizeZip(values.truck),
      pickup: normalizeZip(values.pickup),
      dropoff: normalizeZip(values.dropoff),
    };
  }

  const activeStops = () => (ltl ? stops : []);

  /** Lookups line up with what they look up; extra ones are stopped. */
  function fit(list, n) {
    while (list.length < n) list.push(new Lookup(onChange));
    for (const lookup of list.slice(n)) lookup.set(null);
  }

  function sync() {
    const z = zips();
    for (const name of Object.keys(places)) places[name].set(z[name], `/api/place?zip=${z[name]}`);
    fit(stopPlaces, stops.length);
    stops.forEach((s, i) => {
      const zip = ltl ? normalizeZip(s.zip) : null;
      stopPlaces[i].set(zip, `/api/place?zip=${zip}`);
    });

    const points = [z.pickup, ...activeStops().map((s) => normalizeZip(s.zip)), z.dropoff];
    const key = points.every(Boolean) ? points.join('-') : null;
    if (key !== routeKey) values.loaded = '';  // new route: back to looked-up miles
    routeKey = key;
    const n = key ? points.length - 1 : 0;
    fit(legs, n);
    for (let i = 0; i < n; i++) legs[i].set(`${points[i]}-${points[i + 1]}`, `/api/miles?from=${points[i]}&to=${points[i + 1]}`);

    const emptyKey = z.truck && z.pickup && z.truck !== z.pickup ? `${z.truck}-${z.pickup}` : null;
    if (emptyKey && emptyKey !== empty.key) values.deadhead = '';  // truck moved: back to looked-up empty miles
    empty.set(emptyKey, `/api/miles?from=${z.truck}&to=${z.pickup}`);
  }

  /** The route's legs added up once every one has come back. */
  function route() {
    const states = routeKey ? legs.slice(0, routeKey.split('-').length - 1).map((l) => l.state) : [];
    const ok = states.length > 0 && states.every((s) => s.status === 'ok');
    return {
      states,
      loading: states.some((s) => s.status === 'loading'),
      error: states.find((s) => s.status === 'error')?.error ?? null,
      estimated: states.some((s) => s.data?.source === 'estimate'),
      data: ok ? {
        pickup: states[0].data.pickup,
        dropoff: states.at(-1).data.dropoff,
        miles: states.reduce((sum, s) => sum + s.data.miles, 0),
        stops: states.length - 1,
      } : null,
    };
  }

  return {
    values,
    stops,
    get ltl() { return ltl; },

    set(field, text) {
      values[field] = text;
      sync();
    },

    setLtl(on) {
      ltl = on;
      sync();
    },

    addStop(kind = 'drop') {
      if (stops.length >= MAX_STOPS) return;
      stops.push({ zip: '', kind, rate: '' });
      sync();
    },

    /** field is 'zip', 'kind' ('pickup' or 'drop') or 'rate'. */
    setStop(i, field, text) {
      stops[i][field] = text;
      sync();
    },

    removeStop(i) {
      stops.splice(i, 1);
      sync();
    },

    /** Clear the current load but keep where the truck is. */
    clear() {
      for (const f of Object.keys(values)) if (f !== 'truck') values[f] = '';
      stops.length = 0;
      ltl = false;
      sync();
    },

    /** Everything the views need, with typed numbers taking priority over looked-up ones. */
    current() {
      const z = zips();
      const typed = (f) => values[f].trim() !== '';
      const trip = route();
      const loadedAuto = trip.data?.miles ?? null;
      let deadheadAuto = 0;
      if (empty.key) deadheadAuto = empty.state.status === 'ok' ? empty.state.data.miles : null;
      const stopList = activeStops().map((s, i) => ({
        zip: normalizeZip(s.zip),
        kind: s.kind,
        rate: s.kind === 'pickup' ? parseNumber(s.rate) : null,
        place: stopPlaces[i].state,
      }));
      // one rate per pickup: the first pickup's, then each pickup stop's; the total counts once all are in
      const rates = [parseNumber(values.rate), ...stopList.filter((s) => s.kind === 'pickup').map((s) => s.rate)];
      const rate = rates.every((r) => r !== null) ? rates.reduce((a, b) => a + b, 0) : null;
      const stopoff = parseNumber(values.stopoff) ?? 0;
      return {
        zips: z,
        places: Object.fromEntries(Object.entries(places).map(([field, lookup]) => [field, lookup.state])),
        ltl,
        stops: stopList,
        stopsIncomplete: stopList.some((s) => !s.zip),
        partials: rates.length,
        rate,
        stopoff,
        pay: rate !== null ? rate + stopoff : null,  // what the verdict judges: the offer plus agreed stop-off pay
        counter: parseNumber(values.counter),
        loaded: typed('loaded') ? parseNumber(values.loaded) : loadedAuto,
        loadedAuto,
        loadedTyped: typed('loaded'),
        deadhead: typed('deadhead') ? parseNumber(values.deadhead) : deadheadAuto,
        deadheadAuto,
        deadheadTyped: typed('deadhead'),
        emptyLookup: Boolean(empty.key),
        tripLoading: trip.loading,
        pending: trip.loading || (empty.key && empty.state.status === 'loading'),
        tripError: trip.error,
        emptyError: empty.key && empty.state.status === 'error' ? empty.state.error : null,
        estimated: trip.estimated || (empty.state.data?.source === 'estimate'),
        route: trip.data,
      };
    },
  };
}
