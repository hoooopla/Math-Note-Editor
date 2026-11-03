import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'math-note-desktop-stress-'));
const workspace = path.join(root, 'workspace');
const profile = path.join(root, 'profile');
await Promise.all([fs.mkdir(workspace), fs.mkdir(profile)]);
const scale = Math.min(4, Math.max(1, Number(process.env.STRESS_SCALE) || 1));
const cases = [
  ['plain', Array.from({ length: 1_600 * scale }, (_, i) =>
    `Line ${i}: We can refine this proof while keeping its definitions and references intact.\n`).join('')],
  ['math', Array.from({ length: 240 * scale }, (_, i) =>
    `Step ${i}: $\\frac{x_${i}+y_${i}}{1+z_${i}^2}\\leq\\sum_{k=1}^{n} a_k$ follows from the estimate.\n`).join('')]
];
const env = {
  ...process.env,
  MATH_NOTE_WORKSPACE: workspace,
  MATH_NOTE_STRESS_USER_DATA: profile
};
delete env.ELECTRON_RUN_AS_NODE;
let desktop;
let succeeded = false;
const report = { cases: [], profileIsolated: false, workspaceIsolated: false };

async function poll(check, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Condition did not become true within ${timeoutMs} ms`);
}

try {
  desktop = await electron.launch({ args: [projectDir], cwd: projectDir, env, timeout: 45_000 });
  const page = await desktop.firstWindow();
  const failures = [];
  page.on('crash', () => failures.push('renderer crashed'));
  page.on('pageerror', error => failures.push(error.message));
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 45_000 });
  const origin = new URL(page.url()).origin;
  const runtime = await (await page.request.get(`${origin}/api/runtime`)).json();
  assert.equal(runtime.desktop, true);
  assert.equal(runtime.testMode, false);
  assert.equal(runtime.workspaceName, 'workspace');
  report.workspaceIsolated = true;
  const remembered = JSON.parse(await fs.readFile(path.join(profile, 'desktop-settings.json'), 'utf8'));
  assert.equal(remembered.workspace, workspace);
  report.profileIsolated = true;
  await page.getByRole('button', { name: 'Search', exact: true }).waitFor();

  for (const [kind, content] of cases) {
    const label = `test:desktop-stress-${kind}`;
    const created = await page.request.post(`${origin}/api/blocks`, {
      data: { title: `Desktop stress ${kind}`, label, content: '' }
    });
    assert.equal(created.ok(), true, await created.text());
    const { id } = await created.json();
    // The API-created block may arrive before the desktop store handles its SSE
    // update. Reload so search definitely sees the generated scratch note.
    await page.reload();
    await page.getByRole('button', { name: 'Search', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(label);
    await page.getByText(label, { exact: true }).last().waitFor();
    await search.press('Enter');
    await page.getByRole('tab', { name: new RegExp(`Desktop stress ${kind}`) }).waitFor();
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await editor.waitFor({ state: 'visible' });
    const savedEquals = async expected => {
      const response = await page.request.get(`${origin}/api/blocks/${id}`);
      return response.ok() && (await response.json()).content === expected;
    };
    const metrics = { kind, bytes: Buffer.byteLength(content) };
    report.cases.push(metrics);
    await desktop.evaluate(({ clipboard }, value) => clipboard.writeText(value), content);
    await editor.focus();
    const pasteStart = Date.now();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
    await editor.evaluate(element => element.blur());
    await poll(() => savedEquals(content));
    metrics.pasteAndSaveMs = Date.now() - pasteStart;

    await editor.focus();
    await page.keyboard.press('ControlOrMeta+End');
    const typed = '\nA short new thought: $x+y=z$.';
    const typingStart = Date.now();
    await page.keyboard.type(typed);
    await editor.evaluate(element => element.blur());
    await poll(() => savedEquals(content + typed));
    metrics.typeAndSaveMs = Date.now() - typingStart;

    const deletionStart = Date.now();
    await editor.focus();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('Backspace');
    assert.equal(await editor.textContent(), '');
    await editor.evaluate(element => element.blur());
    await poll(() => savedEquals(''), 10_000).catch(async () => {
      const saved = (await (await page.request.get(`${origin}/api/blocks/${id}`)).json()).content;
      throw new Error(`Bulk deletion left ${saved.length} characters in the desktop note.`);
    });
    metrics.deleteAndSaveMs = Date.now() - deletionStart;

    await editor.focus();
    await page.keyboard.type('Editing continues after deletion.');
    assert.equal(await editor.innerText(), 'Editing continues after deletion.');
    await editor.evaluate(element => element.blur());
    await poll(() => savedEquals('Editing continues after deletion.'));
    assert.deepEqual(failures, []);
    console.log(`Desktop stress ${kind}: ${JSON.stringify(metrics)}`);
  }

  succeeded = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  if (desktop) await desktop.close().catch(() => {});
  const resultsDir = path.join(projectDir, '.playwright-results');
  await fs.mkdir(resultsDir, { recursive: true });
  await fs.writeFile(path.join(resultsDir, 'desktop-stress-summary.json'), JSON.stringify(report, null, 2));
  if (succeeded) await fs.rm(root, { recursive: true, force: true });
  else console.error(`Generated stress workspace retained for diagnosis: ${root}`);
}
