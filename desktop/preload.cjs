const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('mathNotesDesktop', {
  checkSelectedSpelling(word) {
    if (typeof word !== 'string' || word.length > 80) return null;
    return webFrame.isWordMisspelled(word)
      ? { word, suggestions: webFrame.getWordSuggestions(word) }
      : null;
  },
  updateShortcuts(shortcuts) {
    ipcRenderer.send('update-shortcuts', shortcuts);
  },
  chooseWorkspace() {
    return ipcRenderer.invoke('choose-workspace');
  },
  getWorkspacePath() {
    return ipcRenderer.invoke('get-workspace-path');
  },
  showWorkspaceInFolder() {
    return ipcRenderer.invoke('show-workspace-in-folder');
  },
  onCommand(callback) {
    const listener = (_event, command) => callback(command);
    ipcRenderer.on('note-command', listener);
    return () => ipcRenderer.removeListener('note-command', listener);
  },
  onPrepareWorkspaceChange(callback) {
    const listener = async (_event, requestId) => {
      try {
        await callback();
        ipcRenderer.send('workspace-flush-complete', requestId, null);
      } catch (error) {
        ipcRenderer.send('workspace-flush-complete', requestId, error instanceof Error ? error.message : String(error));
      }
    };
    ipcRenderer.on('prepare-workspace-change', listener);
    return () => ipcRenderer.removeListener('prepare-workspace-change', listener);
  }
});
