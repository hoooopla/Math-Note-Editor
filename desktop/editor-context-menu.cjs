function editorContextMenuTemplate(params, webContents, selectedSpelling = null, workspaceHistory = null) {
  const template = [];
  const flags = params.editFlags || {};

  const misspelledWord = params.misspelledWord || selectedSpelling?.word;
  if (params.isEditable && params.spellcheckEnabled && misspelledWord) {
    const suggestions = [...new Set(params.misspelledWord ? params.dictionarySuggestions || [] : selectedSpelling?.suggestions || [])].slice(0, 6);
    if (suggestions.length) {
      for (const suggestion of suggestions) {
        template.push({
          label: suggestion,
          click: () => params.misspelledWord ? webContents.replaceMisspelling(suggestion) : webContents.insertText(suggestion)
        });
      }
    } else {
      template.push({ label: 'No spelling suggestions', enabled: false });
    }
    template.push({
      label: `Add “${misspelledWord}” to dictionary`,
      click: () => webContents.session.addWordToSpellCheckerDictionary(misspelledWord)
    });
    template.push({ type: 'separator' });
  }

  if (params.isEditable) {
    template.push(
      workspaceHistory ? { label: 'Undo', enabled: true, click: workspaceHistory.undo } : { role: 'undo', enabled: !!flags.canUndo },
      workspaceHistory ? { label: 'Redo', enabled: true, click: workspaceHistory.redo } : { role: 'redo', enabled: !!flags.canRedo },
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
