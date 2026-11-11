// Shared by the Simple and Advanced screens: server calls, settings saving,
// DOM helpers and the "window is open/closed" signals.

import { money } from './calc.js';
import { morph, setText } from './fx.js';

const ICONS = { book: '✓', negotiate: '↑', drop: '✕', check: '!' };

const clientId = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

let connectionListener = () => {};

/** Called with true/false whenever the app server becomes reachable / unreachable. */
export function onConnectionChange(fn) {
  connectionListener = fn;
}

export async function api(path, { method = 'GET', body, signal } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      signal,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    connectionListener(false);
    throw new Error('Lost connection to the app');
  }
  connectionListener(true);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

/**
 * The answer box: icon, title and lines; it settles in once each time the verdict changes.
 * `kind` is a verdict, '' for a plain message, or 'pending' while miles are looked up.
 */
export function verdictPanel(node) {
  const base = node.className;
  let lastVerdict = null;
  return {
    show(kind, title, ...lines) {
      node.className = `${base} ${kind}`;
      const heading = ICONS[kind] ? el('h2', {}, el('span', { class: 'v-icon', 'aria-hidden': 'true' }, ICONS[kind]), title)
        : el('h2', {}, title);
      node.replaceChildren(heading, ...lines);
      if (kind !== lastVerdict) {
        lastVerdict = kind;
        if (ICONS[kind]) morph(node);
      }
    },
    reset() {
      lastVerdict = null;
    },
  };
}

/** The line under "Check the offer": the number they probably meant, if there is one. */
export function typoHint(typo) {
  return el('p', {}, typo.suggestion
    ? `Did you mean ${money(typo.suggestion, typo.suggestion % 1 !== 0)}?`
    : 'Make sure the number is right before you book.');
}

/** 0 -> 'today', 1 -> '1 day ago', 6 -> '6 days ago'. */
export function daysAgo(days) {
  return days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'} ago`;
}

/** A short, polite counteroffer to paste into an email or chat. It asks; it doesn't promise. */
export function counterMessage({ from, to, stops = 0, miles, amount }) {
  const via = stops ? ` with ${stops} stop${stops === 1 ? '' : 's'}` : '';
  return `Thanks for the load. For ${from} → ${to}${via} (${Math.round(miles).toLocaleString('en-US')} loaded mi), `
    + `I can do ${money(amount, amount % 1 !== 0)} all-in. Let me know if that works.`;
}

/** A small button that copies `text()` and says so for a moment. */
export function copyButton(label, text) {
  const btn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm' }, label);
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text());
      btn.textContent = 'Copied';
    } catch {
      btn.textContent = 'Couldn’t copy';
    }
    setTimeout(() => { btn.textContent = label; }, 1500);
  });
  return btn;
}

export function tile(value, label, cls = 'tile') {
  return el('div', { class: cls }, el('b', {}, value), el('span', {}, label));
}

/** Update tiles in place so values animate instead of the whole row flashing. */
export function syncTiles(container, tiles) {
  const old = [...container.children];
  if (old.length !== tiles.length) {
    container.replaceChildren(...tiles);
    return;
  }
  tiles.forEach((t, i) => {
    const [b, span] = old[i].children;
    setText(b, t.children[0].textContent);
    span.replaceChildren(...t.children[1].childNodes);
    old[i].className = t.className;
  });
}

/**
 * Batches setting changes and saves them shortly after the user stops typing.
 * `onSaved` gets each batch once the server has stored it; `onRejected` gets
 * (key, message) for a value the server refuses, which is then dropped.
 * Lost connections and server errors are retried after each of `retryDelays`.
 */
export function createSettingsSaver({
  onSaved = () => {}, onRejected = () => {}, delay = 400, retryDelays = [1000, 5000, 15000, 30000],
} = {}) {
  let pending = {};
  let timer = 0;
  let failures = 0;
  let inFlight = Promise.resolve();

  /** Save a batch; returns the changes that should be tried again later. */
  async function save(changes) {
    try {
      await api('/api/settings', { method: 'POST', body: changes });
    } catch (err) {
      if (!(err.status >= 400 && err.status < 500)) return changes;
      const keys = Object.keys(changes);
      if (keys.length === 1) {
        onRejected(keys[0], err.message);
        return {};
      }
      // the server takes a batch all or nothing; save the keys one by one to keep the good ones
      let retry = {};
      for (const key of keys) retry = { ...retry, ...(await save({ [key]: changes[key] })) };
      return retry;
    }
    onSaved(changes);
    return {};
  }

  async function send() {
    clearTimeout(timer);
    const changes = pending;
    pending = {};
    if (!Object.keys(changes).length) return;
    const retry = await save(changes);
    if (!Object.keys(retry).length) {
      failures = 0;
      return;
    }
    pending = { ...retry, ...pending };  // anything typed meanwhile is newer
    if (failures < retryDelays.length) timer = setTimeout(flush, retryDelays[failures++]);
  }

  // one request at a time, so saves reach the server in the order they were made
  const flush = () => (inFlight = inFlight.then(send).catch((err) => console.error(err)));

  return {
    queue(key, value) {
      pending[key] = value;
      failures = 0;
      clearTimeout(timer);
      timer = setTimeout(flush, delay);
    },
    /** Last-chance save while the window is closing. */
    beacon() {
      if (Object.keys(pending).length) {
        navigator.sendBeacon('/api/settings', JSON.stringify(pending));
        pending = {};
      }
    },
  };
}

/**
 * The app re-checks rates in the background. Pick up changes shortly after
 * opening, every 10 minutes, and whenever the window comes back into view.
 */
export function watchMarket(onUpdate) {
  let last = '';
  const check = async () => {
    try {
      const market = await api('/api/market');
      const key = JSON.stringify(market);
      if (key !== last) {
        last = key;
        onUpdate(market);
      }
    } catch { /* not running; the connection notice covers it */ }
  };
  setTimeout(check, 6000);
  setInterval(check, 10 * 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });
  return check;
}

/** Tell the app when this window opens and closes, so it can exit after the last one. */
export function trackWindow(saver) {
  const hello = () => api('/api/hello', { method: 'POST', body: { id: clientId } }).catch(() => {});
  window.addEventListener('pagehide', () => {
    saver?.beacon();
    navigator.sendBeacon('/api/bye', JSON.stringify({ id: clientId }));
  });
  window.addEventListener('pageshow', (e) => { if (e.persisted) hello(); });
  hello();
}
