import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const projectDir = path.resolve(import.meta.dirname, '..');
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'math-note-desktop-smoke-'));
await fs.writeFile(path.join(workspace, 'legacy-note.md.bak'), 'legacy backup');

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

async function waitForServer(url) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/runtime`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('Bundled desktop server did not become ready.');
}

const port = await availablePort();
const url = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [path.join(projectDir, 'desktop-server', 'server.cjs'), '--production', '--port', String(port)], {
  cwd: projectDir,
  env: {
    ...process.env,
    MATH_NOTE_DESKTOP: 'true',
    MATH_NOTE_WORKSPACE: workspace,
    MATH_NOTE_DIST_DIR: path.join(projectDir, 'dist')
  },
  stdio: 'inherit'
});

try {
  await waitForServer(url);
  const runtime = await (await fetch(`${url}/api/runtime`)).json();
  if (!runtime.desktop || runtime.testMode) throw new Error(`Unexpected runtime response: ${JSON.stringify(runtime)}`);

  const settingsResponse = await fetch(`${url}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ macros: { '\\R': '\\mathbb{R}' }, customCommands: [], textCommands: [] })
  });
  if (!settingsResponse.ok) throw new Error('Could not save shared workspace settings.');
  const updatedSettingsResponse = await fetch(`${url}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ macros: { '\\C': '\\mathbb{C}' }, customCommands: [], textCommands: [] })
  });
  if (!updatedSettingsResponse.ok) throw new Error('Could not update shared workspace settings.');

  const noteResponse = await fetch(`${url}/api/blocks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Desktop smoke test', label: 'desktop:smoke', content: 'Shared workspace' })
  });
  if (!noteResponse.ok) throw new Error('Could not save a note in the desktop workspace.');
  const note = await noteResponse.json();
  const updateResponse = await fetch(`${url}/api/blocks/${encodeURIComponent(note.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...note, content: 'Updated shared workspace' })
  });
  if (!updateResponse.ok) throw new Error('Could not update a note in the desktop workspace.');

  await fs.access(path.join(workspace, 'setting', 'settings.json'));
  const backupDirectory = path.join(workspace, '.math-note-backups');
  const settingsBackup = JSON.parse(await fs.readFile(path.join(backupDirectory, 'setting', 'settings.json.bak'), 'utf-8'));
  if (settingsBackup.macros?.['\\R'] !== '\\mathbb{R}') {
    throw new Error('The settings backup does not contain the previous saved version.');
  }
  const files = await fs.readdir(workspace);
  const noteFilename = files.find(file => file.endsWith('.md') && file.includes('Desktop smoke test'));
  if (!noteFilename) {
    throw new Error('The smoke-test Markdown note was not written to the workspace root.');
  }
  const currentNote = await fs.readFile(path.join(workspace, noteFilename), 'utf-8');
  const noteBackup = await fs.readFile(path.join(backupDirectory, `${noteFilename}.bak`), 'utf-8');
  if (!currentNote.includes('Updated shared workspace') || !noteBackup.includes('Shared workspace')) {
    throw new Error('The note and its backup do not contain the expected current and previous versions.');
  }
  if (await fs.access(path.join(workspace, 'legacy-note.md.bak')).then(() => true, () => false)) {
    throw new Error('A legacy sidecar backup was not removed after migration.');
  }
  if (await fs.readFile(path.join(backupDirectory, 'legacy-note.md.bak'), 'utf-8') !== 'legacy backup') {
    throw new Error('A legacy sidecar backup was not migrated into the centralized backup folder.');
  }
  console.log('Desktop workspace smoke test passed.');
} finally {
  if (server.exitCode === null) {
    server.kill();
    await Promise.race([
      once(server, 'exit'),
      new Promise(resolve => setTimeout(resolve, 3000))
    ]);
  }
  await fs.rm(workspace, { recursive: true, force: true });
}
