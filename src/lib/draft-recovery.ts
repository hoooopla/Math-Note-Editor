export interface RecoveryDraft {
  id: string;
  title: string;
  label: string;
  content?: string;
  baseRevision?: string;
  updatedAt: number;
}

export type RecoveryWorkspace = { mode: 'server' | 'local' | 'google'; name: string };

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const pending = new Map<string, RecoveryDraft>();
const writes = new Map<string, Promise<void>>();

export function flushRecoveryWritesOnExit() {
  for (const [key, draft] of pending) {
    const timer = timers.get(key);
    if (timer) clearTimeout(timer);
    timers.delete(key);
    pending.delete(key);
    void fetch(`/api/recovery/${encodeURIComponent(draft.id)}`, {
      method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft)
    }).catch(() => undefined);
  }
}

function storageKey(workspace: RecoveryWorkspace) {
  return `math-note-recovery:v1:${workspace.mode}:${workspace.name}`;
}

function readLocal(workspace: RecoveryWorkspace): Record<string, RecoveryDraft> {
  const value = localStorage.getItem(storageKey(workspace));
  if (!value) return {};
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid local recovery data');
  return parsed as Record<string, RecoveryDraft>;
}

function validDraft(value: unknown): value is RecoveryDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Partial<RecoveryDraft>;
  return typeof draft.id === 'string' && typeof draft.title === 'string' &&
    typeof draft.label === 'string' && (draft.content === undefined || typeof draft.content === 'string') &&
    (draft.baseRevision === undefined || typeof draft.baseRevision === 'string') &&
    typeof draft.updatedAt === 'number';
}

async function request(url: string, method: string, data?: RecoveryDraft) {
  const response = await fetch(url, { method, headers: data ? { 'Content-Type': 'application/json' } : undefined,
    body: data ? JSON.stringify(data) : undefined });
  if (!response.ok) throw new Error(`Could not ${method === 'DELETE' ? 'discard' : 'save'} recovery draft (${response.status})`);
  return response;
}

function scheduleServerWrite(workspace: RecoveryWorkspace, draft: RecoveryDraft, onError: (error: Error) => void) {
  if (workspace.mode !== 'server') return;
  const key = `${storageKey(workspace)}:${draft.id}`;
  pending.set(key, draft);
  const old = timers.get(key);
  if (old) clearTimeout(old);
  timers.set(key, setTimeout(() => {
    timers.delete(key);
    const latest = pending.get(key);
    pending.delete(key);
    if (!latest) return;
    const previous = writes.get(key) || Promise.resolve();
    const write = previous.catch(() => undefined).then(() => request(`/api/recovery/${encodeURIComponent(latest.id)}`, 'PUT', latest)).then(() => undefined);
    writes.set(key, write);
    void write.catch(error => onError(error instanceof Error ? error : new Error(String(error))));
  }, 100));
}

export function saveRecoveryDraft(workspace: RecoveryWorkspace, draft: RecoveryDraft, onError: (error: Error) => void) {
  let localError: unknown;
  try {
    const records = readLocal(workspace);
    records[draft.id] = draft;
    localStorage.setItem(storageKey(workspace), JSON.stringify(records));
  } catch (error) { localError = error; }
  scheduleServerWrite(workspace, draft, onError);
  if (localError) onError(new Error(`Browser draft storage is unavailable: ${String(localError)}`));
}

export function getLocalRecoveryDraft(workspace: RecoveryWorkspace, id: string) {
  return readLocal(workspace)[id];
}

export async function loadRecoveryDrafts(workspace: RecoveryWorkspace, onWarning?: (message: string) => void): Promise<RecoveryDraft[]> {
  let local: Record<string, RecoveryDraft> = {};
  try { local = readLocal(workspace); }
  catch (error) {
    onWarning?.(`Browser recovery data could not be read: ${String(error)}`);
    if (workspace.mode !== 'server') return [];
  }
  const merged: Record<string, RecoveryDraft> = {};
  if (workspace.mode === 'server') {
    const response = await request('/api/recovery', 'GET');
    const body = await response.json() as { drafts?: unknown[]; errors?: string[] };
    if (body.errors?.length) onWarning?.(`Some recovery drafts could not be read: ${body.errors.join('; ')}`);
    for (const draft of body.drafts || []) if (validDraft(draft)) merged[draft.id] = draft;
  }
  for (const draft of Object.values(local)) if (validDraft(draft) && (!merged[draft.id] || draft.updatedAt > merged[draft.id].updatedAt)) merged[draft.id] = draft;
  return Object.values(merged).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function discardRecoveryDraft(workspace: RecoveryWorkspace, id: string, expectedUpdatedAt?: number) {
  const key = `${storageKey(workspace)}:${id}`;
  if (expectedUpdatedAt !== undefined && getLocalRecoveryDraft(workspace, id)?.updatedAt !== expectedUpdatedAt) return;
  const timer = timers.get(key);
  if (timer) { clearTimeout(timer); timers.delete(key); }
  pending.delete(key);
  const previous = writes.get(key) || Promise.resolve();
  const deletion = previous.catch(() => undefined).then(async () => {
    if (expectedUpdatedAt !== undefined && getLocalRecoveryDraft(workspace, id)?.updatedAt !== expectedUpdatedAt) return;
    if (workspace.mode === 'server') await request(`/api/recovery/${encodeURIComponent(id)}`, 'DELETE');
  });
  writes.set(key, deletion);
  await deletion;
  let records: Record<string, RecoveryDraft>;
  try { records = readLocal(workspace); }
  catch (error) {
    if (workspace.mode !== 'server') throw error;
    records = {};
  }
  if (expectedUpdatedAt !== undefined && records[id]?.updatedAt !== expectedUpdatedAt) return;
  delete records[id];
  try { localStorage.setItem(storageKey(workspace), JSON.stringify(records)); }
  catch (error) { if (workspace.mode !== 'server') throw error; }
}
