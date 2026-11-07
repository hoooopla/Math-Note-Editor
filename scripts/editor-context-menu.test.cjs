const assert = require('node:assert/strict');
const test = require('node:test');
const { editorContextMenuTemplate } = require('../desktop/editor-context-menu.cjs');

const editableFlags = {
  canUndo: true, canRedo: false, canCut: true, canCopy: true,
  canPaste: true, canSelectAll: true
};

test('offers spelling replacements and enabled edit actions for editable text', () => {
  const replacements = [];
  const addedWords = [];
  const menu = editorContextMenuTemplate({
    isEditable: true,
    spellcheckEnabled: true,
    misspelledWord: 'teh',
    dictionarySuggestions: ['the', 'The', 'the'],
    editFlags: editableFlags
  }, {
    replaceMisspelling: suggestion => replacements.push(suggestion),
    session: { addWordToSpellCheckerDictionary: word => addedWords.push(word) }
  });

  assert.deepEqual(menu.filter(item => item.label).map(item => item.label),
    ['the', 'The', 'Add “teh” to dictionary']);
  menu[0].click();
  menu[2].click();
  assert.deepEqual(replacements, ['the']);
  assert.deepEqual(addedWords, ['teh']);
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

test('offers suggestions for a selected misspelling and replaces the selection', () => {
  const inserted = [];
  const added = [];
  const menu = editorContextMenuTemplate({
    isEditable: true, spellcheckEnabled: true, selectionText: 'properity',
    editFlags: editableFlags
  }, {
    insertText: text => inserted.push(text),
    session: { addWordToSpellCheckerDictionary: word => added.push(word) }
  }, { word: 'properity', suggestions: ['property', 'propriety'] });
  assert.deepEqual(menu.slice(0, 3).map(item => item.label),
    ['property', 'propriety', 'Add “properity” to dictionary']);
  menu[0].click();
  menu[2].click();
  assert.deepEqual(inserted, ['property']);
  assert.deepEqual(added, ['properity']);
});

test('ordinary selected text keeps the edit menu', () => {
  const menu = editorContextMenuTemplate({
    isEditable: true, spellcheckEnabled: true, selectionText: 'ordinary',
    editFlags: editableFlags
  }, {}, null);
  assert.equal(menu.some(item => item.label?.includes('dictionary')), false);
});

test('routes editor undo and redo through workspace history', () => {
  const commands = [];
  const menu = editorContextMenuTemplate({
    isEditable: true,
    editFlags: { ...editableFlags, canUndo: false, canRedo: false }
  }, {}, null, {
    undo: () => commands.push('undo'),
    redo: () => commands.push('redo')
  });
  const undo = menu.find(item => item.label === 'Undo');
  const redo = menu.find(item => item.label === 'Redo');
  assert.equal(undo.enabled, true);
  assert.equal(redo.enabled, true);
  undo.click();
  redo.click();
  assert.deepEqual(commands, ['undo', 'redo']);
  assert.equal(menu.some(item => item.role === 'undo' || item.role === 'redo'), false);
});
