// Shared by the Simple and Advanced screens: server calls, settings saving,
// DOM helpers and the "window is open/closed" signals.

import { money } from './calc.js';
import { morph, setText } from './fx.js';

const ICONS = { book: '✓', negotiate: '↑', drop: '✕', check: '!' };

export const clientId = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

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

/** The answer box: icon, title and lines; it settles in once each time the verdict changes. */
export function verdictPanel(node) {
  const base = node.className;
  let lastVerdict = null;
  return {
    show(kind, title, ...lines) {
      node.className = `${base} ${kind}`;
      const heading = kind ? el('h2', {}, el('span', { class: 'v-icon', 'aria-hidden': 'true' }, ICONS[kind]), title)
        : el('h2', {}, title);
      node.replaceChildren(heading, ...lines);
      if (kind !== lastVerdict) {
        lastVerdict = kind;
        if (kind) morph(node);
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
 * `onSaved` gets each batch once the server has stored it.
 */
export function createSettingsSaver(onSaved = () => {}, delay = 400) {
  let pending = {};
  let timer = 0;

  async function flush() {
    clearTimeout(timer);
    const changes = pending;
    pending = {};
    if (!Object.keys(changes).length) return;
    try {
      await api('/api/settings', { method: 'POST', body: changes });
    } catch (err) {
      // A value the server rejects would fail again and block every later save.
      if (!(err.status >= 400 && err.status < 500)) pending = { ...changes, ...pending };  // retry with the next change
      return;
    }
    onSaved(changes);
  }

  return {
    queue(key, value) {
      pending[key] = value;
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
