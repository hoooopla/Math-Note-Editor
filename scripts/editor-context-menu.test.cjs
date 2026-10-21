const assert = require('node:assert/strict');
const test = require('node:test');
const { editorContextMenuTemplate } = require('../desktop/editor-context-menu.cjs');

const editableFlags = {
  canUndo: true, canRedo: false, canCut: true, canCopy: true,
  canPaste: true, canSelectAll: true
};

test('offers spelling replacements and enabled edit actions for editable text', () => {
  const replacements = [];
  const menu = editorContextMenuTemplate({
    isEditable: true,
    spellcheckEnabled: true,
    misspelledWord: 'teh',
    dictionarySuggestions: ['the', 'The', 'the'],
    editFlags: editableFlags
  }, { replaceMisspelling: suggestion => replacements.push(suggestion) });

  assert.deepEqual(menu.filter(item => item.label).map(item => item.label), ['the', 'The']);
  menu[0].click();
  assert.deepEqual(replacements, ['the']);
  assert.equal(menu.find(item => item.role === 'redo').enabled, false);
  assert.equal(menu.find(item => item.role === 'paste').enabled, true);
});

test('limits read-only selections to copying and omits an empty menu', () => {
  const contents = { replaceMisspelling() { throw new Error('Unexpected replacement'); } };
  const selection = editorContextMenuTemplate({
    isEditable: false,
    selectionText: 'selected',
    editFlags: { canCopy: true }
  }, contents);
  assert.deepEqual(selection, [{ role: 'copy', enabled: true }]);
  assert.deepEqual(editorContextMenuTemplate({ isEditable: false, selectionText: '' }, contents), []);
});
