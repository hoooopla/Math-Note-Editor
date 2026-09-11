const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

let mainWindow = null;
let serverProcess = null;
let activeWorkspace = null;
let nextFlushRequestId = 1;
let quitStarted = false;
let allowQuit = false;
const flushRequests = new Map();
let noteShortcuts = {
  closeTab: 'mod+w',
  reopenTab: 'mod+shift+t',
  nextTab: 'ctrl+tab',
  previousTab: 'ctrl+shift+tab'
};

function toAccelerator(value, fallback) {
  const parts = String(value || fallback).toLowerCase().split('+').map(part => part.trim()).filter(Boolean);
  const key = parts.pop();
  if (!key || !/^(?:[a-z0-9]|tab|enter|space|escape|backspace|delete|arrow(?:up|down|left|right)|\/)$/.test(key)) {
    return toAccelerator(fallback, fallback);
  }
  const modifiers = parts.map(part => ({
    mod: 'CmdOrCtrl',
    cmd: 'Command',
    meta: 'Command',
    ctrl: 'Control',
    shift: 'Shift',
    alt: 'Alt'
  })[part]).filter(Boolean);
  if (modifiers.length !== parts.length || modifiers.length === 0) return toAccelerator(fallback, fallback);
  const electronKey = ({
    tab: 'Tab', enter: 'Enter', space: 'Space', escape: 'Escape', backspace: 'Backspace', delete: 'Delete',
    arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right', '/': '/'
  })[key] || key.toUpperCase();
  return [...modifiers, electronKey].join('+');
}

ipcMain.on('update-shortcuts', (_event, shortcuts) => {
  if (!shortcuts || typeof shortcuts !== 'object') return;
  noteShortcuts = { ...noteShortcuts, ...shortcuts };
  installMenu();
});

ipcMain.on('workspace-flush-complete', (_event, requestId, errorMessage) => {
  const request = flushRequests.get(requestId);
  if (!request) return;
  flushRequests.delete(requestId);
  clearTimeout(request.timeout);
  if (errorMessage) request.reject(new Error(errorMessage));
  else request.resolve();
});

function flushRenderer() {
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve();
  const requestId = nextFlushRequestId++;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      flushRequests.delete(requestId);
      reject(new Error('Timed out while saving pending workspace changes.'));
    }, 10000);
    flushRequests.set(requestId, { resolve, reject, timeout });
    mainWindow.webContents.send('prepare-workspace-change', requestId);
  });
}

function preferencesPath() {
  return path.join(app.getPath('userData'), 'desktop-settings.json');
}

function readSavedWorkspace() {
  try {
    const value = JSON.parse(fs.readFileSync(preferencesPath(), 'utf8'))?.workspace;
    return typeof value === 'string' && fs.existsSync(value) ? value : null;
  } catch {
    return null;
  }
}

function saveWorkspace(workspace) {
  fs.mkdirSync(path.dirname(preferencesPath()), { recursive: true });
  fs.writeFileSync(preferencesPath(), JSON.stringify({ workspace }, null, 2));
}

async function selectWorkspace() {
  const configured = process.env.MATH_NOTE_WORKSPACE;
  if (configured) {
    fs.mkdirSync(configured, { recursive: true });
    return path.resolve(configured);
  }

  const saved = readSavedWorkspace();
  if (saved) return saved;

  const result = await dialog.showOpenDialog({
    title: 'Choose your Math Notes workspace',
    buttonLabel: 'Use Workspace',
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || !result.filePaths[0]) return null;
  saveWorkspace(result.filePaths[0]);
  return result.filePaths[0];
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function runtimePaths() {
  if (app.isPackaged) {
    return {
      server: path.join(process.resourcesPath, 'desktop-server', 'server.cjs'),
      web: path.join(process.resourcesPath, 'web')
    };
  }
  return {
    server: path.join(__dirname, '..', 'desktop-server', 'server.cjs'),
    web: path.join(__dirname, '..', 'dist')
  };
}

function waitForServer(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      const request = http.get(`http://127.0.0.1:${port}/api/runtime`, response => {
        response.resume();
        if (response.statusCode === 200) resolve();
        else retry();
      });
      request.once('error', retry);
      request.setTimeout(1000, () => request.destroy());
    };
    const retry = () => {
      if (Date.now() >= deadline) reject(new Error('The local Math Notes service did not start.'));
      else setTimeout(check, 150);
    };
    check();
  });
}

async function startServer(workspace) {
  activeWorkspace = path.resolve(workspace);
  const port = await availablePort();
  const paths = runtimePaths();
  serverProcess = spawn(process.execPath, [paths.server, '--production', '--port', String(port)], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      MATH_NOTE_DESKTOP: 'true',
      MATH_NOTE_WORKSPACE: workspace,
      MATH_NOTE_DIST_DIR: paths.web
    },
    stdio: app.isPackaged ? 'ignore' : 'inherit'
  });
  serverProcess.once('exit', () => { serverProcess = null; });
  await waitForServer(port);
  return port;
}

function stopServer() {
  if (serverProcess && !serverProcess.killed) serverProcess.kill();
  serverProcess = null;
}

function sendNoteCommand(command) {
  mainWindow?.webContents.send('note-command', command);
}

async function chooseAndOpenWorkspace() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose your Math Notes workspace',
    buttonLabel: 'Use Workspace',
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || !result.filePaths[0]) return false;
  try {
    await flushRenderer();
  } catch (error) {
    dialog.showErrorBox('Workspace could not be changed', error instanceof Error ? error.message : String(error));
    return false;
  }
  saveWorkspace(result.filePaths[0]);
  stopServer();
  const port = await startServer(result.filePaths[0]);
  await mainWindow.loadURL(`http://127.0.0.1:${port}`);
  return true;
}

ipcMain.handle('choose-workspace', () => chooseAndOpenWorkspace());
ipcMain.handle('get-workspace-path', () => activeWorkspace);
ipcMain.handle('show-workspace-in-folder', () => {
  if (!activeWorkspace || !fs.existsSync(activeWorkspace)) return false;
  shell.showItemInFolder(activeWorkspace);
  return true;
});

function installMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{
      label: app.name,
      submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }]
    }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Workspace…',
          accelerator: 'CmdOrCtrl+O',
          click: () => { void chooseAndOpenWorkspace(); }
        },
        { type: 'separator' },
        { label: 'Close Note Tab', accelerator: toAccelerator(noteShortcuts.closeTab, 'mod+w'), click: () => sendNoteCommand('close-tab') },
        { label: 'Reopen Closed Note Tab', accelerator: toAccelerator(noteShortcuts.reopenTab, 'mod+shift+t'), click: () => sendNoteCommand('reopen-tab') },
        { type: 'separator' },
        { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', role: 'close' }
      ]
    },
    {
      label: 'Navigate',
      submenu: [
        { label: 'Next Note Tab', accelerator: toAccelerator(noteShortcuts.nextTab, 'ctrl+tab'), click: () => sendNoteCommand('next-tab') },
        { label: 'Previous Note Tab', accelerator: toAccelerator(noteShortcuts.previousTab, 'ctrl+shift+tab'), click: () => sendNoteCommand('previous-tab') }
      ]
    },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow() {
  const workspace = await selectWorkspace();
  if (!workspace) {
    app.quit();
    return;
  }
  saveWorkspace(workspace);
  const port = await startServer(workspace);
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 520,
    title: 'Math Note Editor',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });
  installMenu();
  await mainWindow.loadURL(`http://127.0.0.1:${port}`);
  mainWindow.on('close', event => {
    if (allowQuit) return;
    event.preventDefault();
    void requestQuit();
  });
}

async function requestQuit() {
  if (quitStarted) return;
  quitStarted = true;
  try {
    await flushRenderer();
  } catch (error) {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Keep App Open', 'Quit Anyway'],
      defaultId: 0,
      cancelId: 0,
      message: 'Some workspace changes could not be saved.',
      detail: error instanceof Error ? error.message : String(error)
    });
    if (choice === 0) {
      quitStarted = false;
      return;
    }
  }
  allowQuit = true;
  stopServer();
  app.quit();
}

app.whenReady().then(createWindow).catch(error => {
  dialog.showErrorBox('Math Note Editor could not start', error instanceof Error ? error.message : String(error));
  app.quit();
});

app.on('before-quit', event => {
  if (allowQuit || !mainWindow || mainWindow.isDestroyed()) {
    stopServer();
    return;
  }
  event.preventDefault();
  void requestQuit();
});
app.on('window-all-closed', () => app.quit());
