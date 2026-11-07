import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEmbeddedText, resolveEmbeddedLabel, standoutDisplayTitle, splitMathTitle } from '../src/lib/note-display-core.mjs';

test('embedded links share the editor syntax', () => {
    const parsed = parseEmbeddedText('@/child || $x^2$ ∨');
    assert.equal(resolveEmbeddedLabel(parsed, 'analysis/parent'), 'analysis/parent/child');
    assert.equal(parsed.alias, '$x^2$');
    assert.equal(parsed.open, true);
    assert.equal(parsed.standout, true);
    assert.equal(parseEmbeddedText('label\\∨').open, false);
    assert.equal(parseEmbeddedText('label\\|\\|suffix').label, 'label||suffix');
});

test('title math and standout capitalization remain presentation rules', () => {
    assert.equal(standoutDisplayTitle('a title'), 'A title');
    assert.equal(standoutDisplayTitle('$x$ title'), '$x$ title');
    assert.deepEqual(splitMathTitle('Area $x^2$ and \\[y^2\\]'), [
        {type:'text',content:'Area '}, {type:'math',content:'x^2'},
        {type:'text',content:' and '}, {type:'math',content:'y^2'}
    ]);
});
