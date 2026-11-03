function editorContextMenuTemplate(params, webContents) {
  const template = [];
  const flags = params.editFlags || {};

  if (params.isEditable && params.spellcheckEnabled && params.misspelledWord) {
    const suggestions = [...new Set(params.dictionarySuggestions || [])].slice(0, 6);
    if (suggestions.length) {
      for (const suggestion of suggestions) {
        template.push({
          label: suggestion,
          click: () => webContents.replaceMisspelling(suggestion)
        });
      }
    } else {
      template.push({ label: 'No spelling suggestions', enabled: false });
    }
    template.push({
      label: `Add “${params.misspelledWord}” to dictionary`,
      click: () => webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord)
    });
    template.push({ type: 'separator' });
  }

  if (params.isEditable) {
    template.push(
      { role: 'undo', enabled: !!flags.canUndo },
      { role: 'redo', enabled: !!flags.canRedo },
      { type: 'separator' },
      { role: 'cut', enabled: !!flags.canCut },
      { role: 'copy', enabled: !!flags.canCopy },
      { role: 'paste', enabled: !!flags.canPaste },
      { role: 'selectAll', enabled: !!flags.canSelectAll }
    );
  } else if (params.selectionText) {
    template.push({ role: 'copy', enabled: !!flags.canCopy });
  }

  return template;
}

module.exports = { editorContextMenuTemplate };
