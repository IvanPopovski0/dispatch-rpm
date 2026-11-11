// Just enough DOM for the Simple and Advanced views to render into.

export class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.className = '';
    this.value = '';
    this.dataset = {};
    this.childNodes = [];
    this.classList = { toggle() {}, contains: () => false };
  }
  get children() { return this.childNodes.filter((n) => n instanceof FakeElement); }
  get textContent() { return this.childNodes.map((n) => (n instanceof FakeElement ? n.textContent : String(n))).join(''); }
  set textContent(text) { this.childNodes = text === '' ? [] : [String(text)]; }
  append(...nodes) { this.childNodes.push(...nodes); }
  replaceChildren(...nodes) { this.childNodes = nodes; }
  setAttribute(name, value) {
    (this.attributes ??= {})[name] = String(value);
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = String(value);
  }
  /** Only what the views ask for: 'tag', '.class' or '[attr="value"]'. */
  matches(sel) {
    if (sel.startsWith('.')) return this.className.split(/\s+/).includes(sel.slice(1));
    const attr = /^\[([\w-]+)="([^"]*)"\]$/.exec(sel);
    return attr ? this.attributes?.[attr[1]] === attr[2] : this.tagName === sel;
  }
  querySelectorAll(sel) {
    return this.children.flatMap((c) => [...(c.matches(sel) ? [c] : []), ...c.querySelectorAll(sel)]);
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  getAttribute(name) { return this.attributes?.[name] ?? null; }
  animate() { return { finished: Promise.resolve() }; }
  addEventListener(type, fn) { ((this.listeners ??= {})[type] ??= []).push(fn); }
  /** Run this element's listeners for `type`, as a click or keystroke would. */
  fire(type, event = {}) { return Promise.all((this.listeners?.[type] ?? []).map((fn) => fn({ target: this, ...event }))); }
  focus() {}
  blur() {}
}

globalThis.document = { createElement: (tag) => new FakeElement(tag), documentElement: new FakeElement('html') };
globalThis.matchMedia = () => ({ matches: true });  // reduced motion: no animations

/** A view root whose querySelector hands out one element per selector, made on first use. */
export function fakeRoot(nodes = {}) {
  return { nodes, querySelector: (sel) => (nodes[sel] ??= new FakeElement()), querySelectorAll: () => [] };
}
