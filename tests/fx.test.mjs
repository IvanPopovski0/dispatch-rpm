import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FakeElement } from './fake-dom.mjs';

globalThis.matchMedia = () => ({ matches: false });  // motion allowed, so digits roll
const { setText } = await import('../dispatch_rpm/static/fx.js');

test('rolling digits keep the whole value readable to screen readers', () => {
  const b = new FakeElement('b');
  setText(b, '$3.00');
  assert.equal(b.textContent, '$3.00');

  setText(b, '$3.25');
  const [spoken, ...glyphs] = b.children;
  assert.equal(spoken.className, 'sr-only');
  assert.equal(spoken.textContent, '$3.25');
  assert.equal(glyphs.map((g) => g.textContent).join(''), '$3.25');
  assert.ok(glyphs.every((g) => g.getAttribute('aria-hidden') === 'true'));
  assert.equal(b.getAttribute('aria-label'), null);

  setText(b, '$3.25');
  assert.equal(b.children.length, 6, 'an unchanged value is left alone');
});
