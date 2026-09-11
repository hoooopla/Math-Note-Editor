import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const projectDir = path.resolve(import.meta.dirname, '..');
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'math-note-desktop-smoke-'));

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

  const noteResponse = await fetch(`${url}/api/blocks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Desktop smoke test', label: 'desktop:smoke', content: 'Shared workspace' })
  });
  if (!noteResponse.ok) throw new Error('Could not save a note in the desktop workspace.');

  await fs.access(path.join(workspace, 'setting', 'settings.json'));
  const files = await fs.readdir(workspace);
  if (!files.some(file => file.endsWith('.md') && file.includes('Desktop smoke test'))) {
    throw new Error('The smoke-test Markdown note was not written to the workspace root.');
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
