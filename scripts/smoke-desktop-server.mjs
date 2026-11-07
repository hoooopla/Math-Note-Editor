import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

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
  const sessionResponse = await fetch(`${url}/api/workspace/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ openTabs: ['tab-a', 'tab-b'], activeTab: 'tab-b', lockedTabs: ['tab-a'] })
  });
  if (!sessionResponse.ok) throw new Error('Could not save the workspace tab session.');
  const settingsWithSession = await (await fetch(`${url}/api/settings`)).json();
  if (settingsWithSession.macros?.['\\C'] !== '\\mathbb{C}' ||
      settingsWithSession.workspaceSession?.activeTab !== 'tab-b' ||
      settingsWithSession.workspaceSession?.lockedTabs?.[0] !== 'tab-a') {
    throw new Error('Saving the workspace tab session overwrote settings or failed to persist the active and locked tabs.');
  }

  const noteResponse = await fetch(`${url}/api/blocks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Desktop smoke test', label: 'desktop:smoke', content: 'Shared workspace' })
  });
  if (!noteResponse.ok) throw new Error('Could not save a note in the desktop workspace.');
  const note = await noteResponse.json();
  const currentRevision = async () => (await (await fetch(`${url}/api/blocks/${encodeURIComponent(note.id)}`)).json()).revision;
  const updateResponse = await fetch(`${url}/api/blocks/${encodeURIComponent(note.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...note, content: 'Updated shared workspace', baseRevision: note.revision })
  });
  if (!updateResponse.ok) throw new Error('Could not update a note in the desktop workspace.');

  const recoveryDraft = { id: note.id, title: note.title, label: note.label,
    content: 'Unsaved desktop edit', baseRevision: note.revision, updatedAt: Date.now() };
  const writeDraft = async draft => fetch(`${url}/api/recovery/${encodeURIComponent(note.id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft)
  });
  if (!(await writeDraft(recoveryDraft)).ok) throw new Error('Could not write a desktop recovery draft.');
  if (!(await writeDraft({ ...recoveryDraft, content: 'Old draft', updatedAt: recoveryDraft.updatedAt - 1 })).ok) {
    throw new Error('Could not test recovery write ordering.');
  }
  const diskDraftFiles = await fs.readdir(path.join(workspace, '.math-note-recovery'));
  if (diskDraftFiles.length !== 1) throw new Error('Desktop recovery draft was not written to one workspace file.');
  const diskDraft = JSON.parse(await fs.readFile(path.join(workspace, '.math-note-recovery', diskDraftFiles[0]), 'utf-8'));
  const listedDrafts = await (await fetch(`${url}/api/recovery`)).json();
  if (diskDraft.content !== recoveryDraft.content || listedDrafts.drafts?.[0]?.content !== recoveryDraft.content) {
    throw new Error('An older recovery write replaced the newer draft on disk.');
  }
  if (!(await fetch(`${url}/api/recovery/${encodeURIComponent(note.id)}`, { method: 'DELETE' })).ok ||
      (await (await fetch(`${url}/api/recovery`)).json()).drafts?.length !== 0) {
    throw new Error('Could not discard a desktop recovery draft.');
  }

  await fs.access(path.join(workspace, 'setting', 'settings.json'));
  const backupDirectory = path.join(workspace, '.math-note-backups');
  const settingsBackup = JSON.parse(await fs.readFile(path.join(backupDirectory, 'setting', 'settings.json.bak'), 'utf-8'));
  if (settingsBackup.macros?.['\\C'] !== '\\mathbb{C}' || settingsBackup.workspaceSession) {
    throw new Error('The settings backup does not contain the version from before the tab session was saved.');
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
  const backupList = await (await fetch(`${url}/api/backups`)).json();
  if (!backupList.some(backup => backup.path === noteFilename)) throw new Error('The note backup was not exposed by the recovery API.');
  const restoreResponse = await fetch(`${url}/api/backups/restore`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: noteFilename })
  });
  if (!restoreResponse.ok) throw new Error(`Could not restore the note backup: ${await restoreResponse.text()}`);
  const restoredNote = await fs.readFile(path.join(workspace, noteFilename), 'utf-8');
  const swappedBackup = await fs.readFile(path.join(backupDirectory, `${noteFilename}.bak`), 'utf-8');
  if (!restoredNote.includes('Shared workspace') || !swappedBackup.includes('Updated shared workspace')) {
    throw new Error('Backup restore did not safely swap the current and previous versions.');
  }

  const caseRenameResponse = await fetch(`${url}/api/blocks/${encodeURIComponent(note.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...note, title: 'desktop smoke test', content: 'Shared workspace', baseRevision: await currentRevision() })
  });
  if (!caseRenameResponse.ok) throw new Error(`Could not apply a case-only title rename: ${await caseRenameResponse.text()}`);
  await new Promise(resolve => setTimeout(resolve, 350));
  const afterCaseRename = (await fs.readdir(workspace)).filter(file => file.endsWith('.md') && file.includes(note.id));
  if (afterCaseRename.length !== 1) {
    throw new Error(`A case-only title rename must retain exactly one note file; found ${afterCaseRename.length}.`);
  }
  const caseRenamedText = await fs.readFile(path.join(workspace, afterCaseRename[0]), 'utf-8');
  if (!caseRenamedText.includes('title: desktop smoke test') || !caseRenamedText.includes('Shared workspace')) {
    throw new Error('A case-only title rename did not persist the updated metadata and body.');
  }
  const blocksAfterCaseRename = await (await fetch(`${url}/api/blocks?metaOnly=true`)).json();
  if (!blocksAfterCaseRename.some(block => block.id === note.id && block.title === 'desktop smoke test')) {
    throw new Error('The filesystem watcher removed the note after a case-only title rename.');
  }

  const ordinaryRenameResponse = await fetch(`${url}/api/blocks/${encodeURIComponent(note.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...note, title: 'Renamed desktop note', content: 'Shared workspace', baseRevision: await currentRevision() })
  });
  if (!ordinaryRenameResponse.ok) throw new Error(`Could not apply an ordinary title rename: ${await ordinaryRenameResponse.text()}`);
  await new Promise(resolve => setTimeout(resolve, 350));
  const afterOrdinaryRename = (await fs.readdir(workspace)).filter(file => file.endsWith('.md') && file.includes(note.id));
  if (afterOrdinaryRename.length !== 1 || afterOrdinaryRename[0] !== noteFilename) {
    throw new Error(`A title rename changed the stable note filename: ${afterOrdinaryRename.join(', ')}`);
  }
  const blocksAfterOrdinaryRename = await (await fetch(`${url}/api/blocks?metaOnly=true`)).json();
  if (!blocksAfterOrdinaryRename.some(block => block.id === note.id && block.title === 'Renamed desktop note')) {
    throw new Error('The filesystem watcher removed the note after an ordinary title rename.');
  }
  const finderFilename = `Finder renamed--${note.id}.md`;
  await fs.rename(path.join(workspace, noteFilename), path.join(workspace, finderFilename));
  await new Promise(resolve => setTimeout(resolve, 400));
  const afterFinderRename = await fetch(`${url}/api/blocks/${encodeURIComponent(note.id)}`);
  if (!afterFinderRename.ok || (await afterFinderRename.json()).title !== 'Renamed desktop note') {
    throw new Error('Renaming a Markdown file outside the app lost the note.');
  }
  const beforeExternalEdit = await currentRevision();
  const renamedText = await fs.readFile(path.join(workspace, finderFilename), 'utf-8');
  await fs.writeFile(path.join(workspace, finderFilename), renamedText.replace('Shared workspace', 'Changed in Finder'));
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const current = await (await fetch(`${url}/api/blocks/${encodeURIComponent(note.id)}`)).json();
    if (current.content.includes('Changed in Finder')) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const externallyEdited = await (await fetch(`${url}/api/blocks/${encodeURIComponent(note.id)}`)).json();
  if (!externallyEdited.content.includes('Changed in Finder')) throw new Error('An external Markdown edit did not appear in the workspace.');
  const staleExternalWrite = await fetch(`${url}/api/blocks/${encodeURIComponent(note.id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...externallyEdited, content: 'Stale app edit', baseRevision: beforeExternalEdit })
  });
  if (staleExternalWrite.status !== 409 || !(await fs.readFile(path.join(workspace, finderFilename), 'utf-8')).includes('Changed in Finder')) {
    throw new Error('An old app revision overwrote an external Markdown edit.');
  }
  const restartDraft = { id: note.id, title: externallyEdited.title, label: externallyEdited.label,
    content: 'Draft across desktop restart', baseRevision: externallyEdited.revision, updatedAt: Date.now() + 1000 };
  if (!(await writeDraft(restartDraft)).ok) throw new Error('Could not save the restart recovery draft.');
  await fs.writeFile(path.join(workspace, '.math-note-recovery', 'damaged.json'), '{invalid recovery json');
  if (await fs.access(path.join(workspace, 'legacy-note.md.bak')).then(() => true, () => false)) {
    throw new Error('A legacy sidecar backup was not removed after migration.');
  }
  if (await fs.readFile(path.join(backupDirectory, 'legacy-note.md.bak'), 'utf-8') !== 'legacy backup') {
    throw new Error('A legacy sidecar backup was not migrated into the centralized backup folder.');
  }
  server.kill();
  await once(server, 'exit');
  const restartedPort = await availablePort();
  const restartedUrl = `http://127.0.0.1:${restartedPort}`;
  const restarted = spawn(process.execPath, [path.join(projectDir, 'desktop-server', 'server.cjs'), '--production', '--port', String(restartedPort)], {
    cwd: projectDir,
    env: { ...process.env, MATH_NOTE_DESKTOP: 'true', MATH_NOTE_WORKSPACE: workspace, MATH_NOTE_DIST_DIR: path.join(projectDir, 'dist') },
    stdio: 'inherit'
  });
  let browser;
  try {
    await waitForServer(restartedUrl);
    const drafts = await (await fetch(`${restartedUrl}/api/recovery`)).json();
    if (drafts.drafts?.[0]?.content !== restartDraft.content) throw new Error('The recovery draft did not survive a desktop server restart.');
    if (drafts.errors?.length !== 1 || !drafts.errors[0].includes('damaged.json')) {
      throw new Error('The damaged disk record was not reported alongside the valid draft.');
    }
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(restartedUrl);
    await page.getByRole('dialog', { name: 'Review saved drafts' }).getByText('Draft across desktop restart').waitFor();
  } finally {
    await browser?.close();
    restarted.kill();
    if (restarted.exitCode === null) await Promise.race([once(restarted, 'exit'), new Promise(resolve => setTimeout(resolve, 3000))]);
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
