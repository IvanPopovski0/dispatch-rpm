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
  setAttribute() {}
  addEventListener() {}
  focus() {}
  blur() {}
}

globalThis.document = { createElement: (tag) => new FakeElement(tag), documentElement: new FakeElement('html') };
globalThis.matchMedia = () => ({ matches: true });  // reduced motion: no animations

/** A view root whose querySelector hands out one element per selector, made on first use. */
export function fakeRoot(nodes = {}) {
  return { nodes, querySelector: (sel) => (nodes[sel] ??= new FakeElement()), querySelectorAll: () => [] };
}
