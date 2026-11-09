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

export function createLoad(onChange) {
  const values = { truck: '', pickup: '', dropoff: '', rate: '', loaded: '', deadhead: '' };
  const places = { truck: new Lookup(onChange), pickup: new Lookup(onChange), dropoff: new Lookup(onChange) };
  const trip = new Lookup(onChange);   // pickup -> delivery
  const empty = new Lookup(onChange);  // truck -> pickup

  function zips() {
    return {
      truck: normalizeZip(values.truck),
      pickup: normalizeZip(values.pickup),
      dropoff: normalizeZip(values.dropoff),
    };
  }

  function sync() {
    const z = zips();
    for (const name of Object.keys(places)) places[name].set(z[name], `/api/place?zip=${z[name]}`);

    const tripKey = z.pickup && z.dropoff ? `${z.pickup}-${z.dropoff}` : null;
    if (tripKey !== trip.key) values.loaded = '';      // new lane: back to looked-up miles
    trip.set(tripKey, `/api/miles?from=${z.pickup}&to=${z.dropoff}`);

    const emptyKey = z.truck && z.pickup && z.truck !== z.pickup ? `${z.truck}-${z.pickup}` : null;
    if (emptyKey && emptyKey !== empty.key) values.deadhead = '';  // truck moved: back to looked-up empty miles
    empty.set(emptyKey, `/api/miles?from=${z.truck}&to=${z.pickup}`);
  }

  return {
    values,

    set(field, text) {
      values[field] = text;
      sync();
    },

    /** Clear the current load but keep where the truck is. */
    clear() {
      for (const f of ['pickup', 'dropoff', 'rate', 'loaded', 'deadhead']) values[f] = '';
      sync();
    },

    /** Everything the views need, with typed numbers taking priority over looked-up ones. */
    current() {
      const z = zips();
      const typed = (f) => values[f].trim() !== '';
      const loadedAuto = trip.state.status === 'ok' ? trip.state.data.miles : null;
      let deadheadAuto = 0;
      if (empty.key) deadheadAuto = empty.state.status === 'ok' ? empty.state.data.miles : null;
      return {
        zips: z,
        places: Object.fromEntries(Object.entries(places).map(([field, lookup]) => [field, lookup.state])),
        rate: parseNumber(values.rate),
        loaded: typed('loaded') ? parseNumber(values.loaded) : loadedAuto,
        loadedAuto,
        loadedTyped: typed('loaded'),
        deadhead: typed('deadhead') ? parseNumber(values.deadhead) : deadheadAuto,
        deadheadAuto,
        deadheadTyped: typed('deadhead'),
        emptyLookup: Boolean(empty.key),
        tripLoading: trip.state.status === 'loading',
        pending: trip.state.status === 'loading' || (empty.key && empty.state.status === 'loading'),
        tripError: trip.state.status === 'error' ? trip.state.error : null,
        emptyError: empty.key && empty.state.status === 'error' ? empty.state.error : null,
        estimated: (trip.state.data?.source === 'estimate') || (empty.state.data?.source === 'estimate'),
        route: trip.state.status === 'ok' ? trip.state.data : null,
      };
    },
  };
}
