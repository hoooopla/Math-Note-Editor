const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mathNotesDesktop', {
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
