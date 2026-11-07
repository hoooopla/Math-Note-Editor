import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import { api as backendApi, createDefaultEditorSettings, EditorSettings, WorkspaceBackup, parseFrontmatter, computeReferences } from './api';
import { metadataText } from '../lib/block-metadata';
import { MAX_BLOCK_LABEL_LENGTH, MAX_BLOCK_TITLE_LENGTH, normalizeBlockLabel, normalizeBlockTitle, validateBlockLabel, validateBlockMetadata, validateBlockTitle } from '../lib/label-policy';
import { SafeRelabelPlan } from '../lib/safe-relabel';
import { AssetMovePlan } from '../lib/safe-asset-move';
import { DuplicateLabelIssue, findDuplicateLabelIssues } from '../lib/workspace-validation';
import { resetEmbeddedEditorLifecycle } from '../lib/embedded-editor-lifecycle';
import { resetEmbeddedPrefetchWorkspace } from '../lib/embedded-prefetch';
import { invalidateImageAsset, resetImageResourceWorkspace } from '../lib/editor/image-resources';
import { normalizeEditorSettings, validateEditorSettings } from '../lib/settings-validation';
import { googleDriveWorkspace } from '../lib/google-drive-workspace';
import { discardRecoveryDraft, getLocalRecoveryDraft, loadRecoveryDrafts, saveRecoveryDraft, type RecoveryDraft, type RecoveryWorkspace } from '../lib/draft-recovery';

export interface BlockData {
  id: string;
  title: string;
  label: string;
  content?: string;
  hasContent?: boolean;
  references?: string[];
  revision?: string;
  _fileMeta?: any;
}

interface TabFocusState {
  activeBlockId: string | null;
  activePath: string[] | null;
  activeOccurrenceKey: string | null;
  activeFocusPos: number | null;
  activeFocusX: number | null;
  focusDirection: "start" | "end" | null;
}

interface ClosedTab {
  id: string;
  index: number;
  focusState?: TabFocusState;
}

interface ImageUploadParams {
  file: File | null;
  onInsert: (text: string) => void;
  assertInsertable: () => void;
}

type HistoryDirection = 'undo' | 'redo';
type HistoryEntry =
  | { kind: 'edit'; id: string; field: 'content' | 'title'; before: string; after: string; title: string; ownerTab: string | null; at: number }
  | { kind: 'create'; block: BlockData; index: number; linkedEdit?: { id: string; before: string; after: string }; title: string; ownerTab: string | null; at: number }
  | { kind: 'delete'; block: BlockData; index: number; title: string; ownerTab: string | null; at: number }
  | { kind: 'repair'; id: string; before: string; after: string; title: string; ownerTab: string | null; at: number }
  | { kind: 'relabel'; oldPrefix: string; newPrefix: string; ids: string[]; before: Record<string, BlockData>; after: Record<string, BlockData>; title: string; ownerTab: string | null; at: number }
  | { kind: 'assetMove'; source: string; destination: string; ids: string[]; before: Record<string, string>; after: Record<string, string>; title: string; ownerTab: string | null; at: number };

interface HistoryRequest {
  direction: HistoryDirection;
  label: string;
  crossTab: boolean;
  affectedNotes: Array<{ title: string; label?: string }>;
  change?: { kind: string; from: string; to: string };
  special: boolean;
}

interface WorkspaceActionDetails {
  notes?: Array<{ title: string; label?: string }>;
  destructive?: boolean;
}

export interface AppState {
  isLoaded: boolean;
  isLoadingFiles?: boolean;
  blockOrder: string[];
  blocksById: Record<string, BlockData>;
  blockIdByLabel: Record<string, string>;
  workspaceIssues: DuplicateLabelIssue[];
  blocksRevision: number;
  workspaceRevision: number;
  activeBlockId: string | null;
  activePath: string[] | null;
  activeOccurrenceKey: string | null;
  activeFocusPos: number | null;
  activeFocusX: number | null;
  focusDirection: "start" | "end" | null;
  settings: EditorSettings;
  openTabs: string[];
  activeTab: string | null;
  tabFocusStates: Record<string, TabFocusState>;
  closedTabs: ClosedTab[];
  backendMode: "server" | "local" | "google" | "viewer" | "none";
  googleFolderName: string | null;
  workspaceName: string | null;
  loadViewerFiles: (files: FileList) => Promise<void>;
  initBackend: () => Promise<void>;
  connectLocalFS: () => Promise<void>;
  connectGoogleDrive: () => Promise<void>;
  disconnectGoogleDrive: () => Promise<void>;
  loadBlocks: () => Promise<void>;
  loadSettings: (preserveSession?: boolean) => Promise<void>;
  saveSettings: (settings: EditorSettings) => Promise<boolean>;
  listBackups: () => Promise<WorkspaceBackup[]>;
  restoreBackup: (path: string) => Promise<void>;
  loadBlockContent: (id: string) => Promise<void>;
  addBlock: (data?: Partial<BlockData>) => Promise<BlockData | void>;
  updateBlock: (id: string, data: Partial<BlockData>) => void;
  flushBlock: (id: string) => Promise<void>;
  flushPendingSaves: () => Promise<void>;
  previewRelabel: (oldPrefix: string, newPrefix: string) => Promise<SafeRelabelPlan>;
  commitRelabel: (plan: SafeRelabelPlan) => Promise<void>;
  repairDuplicateLabel: (id: string, newLabel: string) => Promise<boolean>;
  deleteBlock: (id: string) => Promise<void>;
  separateNextEdit: () => void;
  attachLastEditToCreate: (createdId: string) => void;
  historyState: { undoLabel?: string; redoLabel?: string; busy: boolean; replayRevision: number };
  historyRequest: HistoryRequest | null;
  historyUndo: () => Promise<void>;
  historyRedo: () => Promise<void>;
  confirmHistoryRequest: () => Promise<void>;
  cancelHistoryRequest: () => void;
  actionRequest: { label: string; detail: string; notes?: WorkspaceActionDetails['notes']; destructive?: boolean } | null;
  requestWorkspaceAction: (label: string, detail: string, run: () => Promise<void> | void, details?: WorkspaceActionDetails) => Promise<boolean>;
  confirmWorkspaceAction: () => Promise<void>;
  cancelWorkspaceAction: () => void;
  setActiveBlock: (id: string | null, dir?: "start" | "end" | null, path?: string[] | null, pos?: number | null, x?: number | null, occurrenceKey?: string | null) => void;
  setSettings: (settings: EditorSettings) => void;
  setOpenTabs: (tabs: string[]) => void;
  setActiveTab: (id: string | null) => void;
  activateTab: (id: string) => void;
  closeTab: (id: string) => Promise<void>;
  reopenClosedTab: () => void;
  cycleTab: (direction: 1 | -1) => void;
  goToNearestParent: () => boolean;
  activateRootBlock: (id: string, dir?: "start" | "end" | null) => void;
  openBlockInTab: (id: string, activate: boolean) => void;
  openBlockNextToActive: (id: string) => void;
  initSync: () => void;
  saveAsset: (file: File, filename: string, overwrite?: boolean) => Promise<string>;
  assetRevision: number;
  listAssets: () => Promise<string[]>;
  getAssetUrl: (path: string) => Promise<string>;
  previewAssetMove: (source: string, destination: string) => Promise<AssetMovePlan>;
  commitAssetMove: (plan: AssetMovePlan) => Promise<string | undefined>;
  viewOnlyBlocks: Record<string, boolean>;
  toggleViewOnly: (id: string) => void;
  viewerOriginalBlocks: Record<string, BlockData>;
  viewerDraftBlockIds: Record<string, boolean>;
  resetViewerDrafts: () => void;
  imageUploadParams: ImageUploadParams | null;
  setImageUploadParams: (params: ImageUploadParams | null) => void;
  persistenceError: string | null;
  recoveredDrafts: RecoveryDraft[];
  reviewRecoveryDrafts: () => Promise<void>;
  restoreRecoveryDraft: (id: string) => Promise<void>;
  copyRecoveryDraft: (id: string) => Promise<void>;
  discardRecoveryDraft: (id: string) => Promise<void>;
  blockLoadErrors: Record<string, string>;
  clearPersistenceError: () => void;
}

const syncTimeouts: Record<string, ReturnType<typeof setTimeout>> = {};
const dirtyBlockVersions = new Map<string, number>();
const failedBlockSaves = new Map<string, unknown>();
const blockSaveChains = new Map<string, Promise<void>>();
const pendingBlockLabels = new Set<string>();
let workspaceGeneration = 0;
let assetMoveInProgress = false;
let workspaceSwitchInProgress = false;
const undoEntries: HistoryEntry[] = [];
const redoEntries: HistoryEntry[] = [];
const MAX_HISTORY_ENTRIES = 120;
const MAX_HISTORY_CHARACTERS = 8_000_000;
let historyReplayInProgress = false;
let queuedHistoryDirection: HistoryDirection | null = null;
let confirmedActionInProgress = false;
let pendingAction: { run: () => Promise<void> | void; resolve: (accepted: boolean) => void } | null = null;
let forceHistoryBoundary = false;
let lastRecoveryStamp = 0;

function historyLabel(entry: HistoryEntry): string {
  if (entry.kind === 'edit') return entry.field === 'content' ? `Edit ${entry.title}` : `Change title of ${entry.title}`;
  if (entry.kind === 'create') return `Create ${entry.title}`;
  if (entry.kind === 'delete') return `Delete ${entry.title}`;
  if (entry.kind === 'repair') return `Repair label of ${entry.title}`;
  if (entry.kind === 'relabel') return `Rename ${entry.oldPrefix} to ${entry.newPrefix}`;
  return `Move image ${entry.source} to ${entry.destination}`;
}

function historyChange(entry: HistoryEntry, direction: HistoryDirection): HistoryRequest['change'] {
  const reverse = direction === 'undo';
  if (entry.kind === 'relabel') return { kind: 'Label path', from: reverse ? entry.newPrefix : entry.oldPrefix, to: reverse ? entry.oldPrefix : entry.newPrefix };
  if (entry.kind === 'repair') return { kind: 'Label', from: reverse ? entry.after : entry.before, to: reverse ? entry.before : entry.after };
  if (entry.kind === 'assetMove') return { kind: 'Image path', from: reverse ? entry.destination : entry.source, to: reverse ? entry.source : entry.destination };
  if (entry.kind === 'edit' && entry.field === 'title') return { kind: 'Title', from: reverse ? entry.after : entry.before, to: reverse ? entry.before : entry.after };
  return undefined;
}

function historyAffectedNotes(entry: HistoryEntry, blocksById: Record<string, BlockData>): HistoryRequest['affectedNotes'] {
  const ids = entry.kind === 'edit' || entry.kind === 'repair' ? [entry.id] : entry.kind === 'relabel' || entry.kind === 'assetMove' ? entry.ids : [entry.block.id];
  return ids.map(id => {
    const block = blocksById[id] || (entry.kind === 'create' || entry.kind === 'delete' ? entry.block : entry.kind === 'relabel' ? entry.before[id] || entry.after[id] : undefined);
    return { title: block?.title || id, label: block?.label };
  });
}

function updateHistoryState() {
  useStore.setState(state => ({ historyState: {
    undoLabel: undoEntries.length ? historyLabel(undoEntries[undoEntries.length - 1]) : undefined,
    redoLabel: redoEntries.length ? historyLabel(redoEntries[redoEntries.length - 1]) : undefined,
    busy: state.historyState.busy,
    replayRevision: state.historyState.replayRevision
  } }));
}

function historyEntrySize(entry: HistoryEntry): number {
  if (entry.kind === 'edit') return entry.before.length + entry.after.length;
  if (entry.kind === 'create') return (entry.block.content?.length || 0)
    + (entry.linkedEdit ? entry.linkedEdit.before.length + entry.linkedEdit.after.length : 0);
  if (entry.kind === 'delete') return entry.block.content?.length || 0;
  if (entry.kind === 'repair') return entry.before.length + entry.after.length;
  if (entry.kind === 'relabel') return Object.values(entry.before).reduce((size, block) => size + (block.content?.length || 0), 0)
    + Object.values(entry.after).reduce((size, block) => size + (block.content?.length || 0), 0);
  return Object.values(entry.before).reduce((size, content) => size + content.length, 0)
    + Object.values(entry.after).reduce((size, content) => size + content.length, 0);
}

function trimHistory() {
  let size = undoEntries.reduce((sum, entry) => sum + historyEntrySize(entry), 0);
  while (undoEntries.length > 1 && (undoEntries.length > MAX_HISTORY_ENTRIES || size > MAX_HISTORY_CHARACTERS)) {
    size -= historyEntrySize(undoEntries.shift()!);
  }
}

function pushHistory(entry: HistoryEntry) {
  if (historyReplayInProgress) return;
  // A run of ordinary typing in the same note is one undo step. A new action
  // or a pause starts a new step, preserving cross-tab chronological order.
  const previous = undoEntries.at(-1);
  if (entry.kind === 'edit' && entry.field === 'content' && previous?.kind === 'edit'
    && previous.field === 'content' && previous.id === entry.id
    && previous.ownerTab === entry.ownerTab && entry.at - previous.at < 750 && !forceHistoryBoundary) {
    previous.after = entry.after;
    previous.at = entry.at;
  } else if (entry.kind === 'edit' && entry.field === 'title' && previous?.kind === 'relabel'
    && previous.ids.includes(entry.id) && entry.at - previous.at < 5000) {
    previous.after[entry.id] = { ...previous.after[entry.id], title: entry.after };
  } else {
    undoEntries.push(entry);
  }
  trimHistory();
  redoEntries.length = 0;
  forceHistoryBoundary = false;
  updateHistoryState();
}

function clearHistory() {
  queuedHistoryDirection = null;
  undoEntries.length = 0;
  redoEntries.length = 0;
  forceHistoryBoundary = false;
  if (pendingAction) { pendingAction.resolve(false); pendingAction = null; }
  useStore.setState(state => ({
    historyRequest: null,
    actionRequest: null,
    historyState: { busy: false, replayRevision: state.historyState.replayRevision + 1 }
  }));
}

function beginWorkspaceSwitch() {
  if (confirmedActionInProgress || historyReplayInProgress) throw new Error('Finish the current note action before changing workspaces.');
  if (assetMoveInProgress) throw new Error('Finish the image move before changing workspaces.');
  if (workspaceSwitchInProgress) throw new Error('Another workspace change is still running.');
  workspaceSwitchInProgress = true;
}

let eventSource: EventSource | null = null;
let sessionSaveTimer: ReturnType<typeof setTimeout> | null = null;
let sessionSavePromise: Promise<void> = Promise.resolve();

function persistWorkspaceSession() {
  if (sessionSaveTimer) {
    clearTimeout(sessionSaveTimer);
    sessionSaveTimer = null;
  }
  const state = useStore.getState();
  if (state.backendMode !== 'server' && state.backendMode !== 'local' && state.backendMode !== 'google') return sessionSavePromise;
  sessionSavePromise = sessionSavePromise.catch(() => undefined).then(() => {
    const current = useStore.getState();
    const workspaceSession = {
      openTabs: current.openTabs,
      activeTab: current.activeTab,
      lockedTabs: Object.entries(current.viewOnlyBlocks).filter(([, locked]) => locked).map(([id]) => id)
    };
    return backendApi.saveWorkspaceSession(workspaceSession);
  });
  return sessionSavePromise;
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

function recoveryWorkspace(state: AppState): RecoveryWorkspace | null {
  if (state.backendMode === 'server') return { mode: 'server', name: state.workspaceName || 'default' };
  if (state.backendMode === 'local') return { mode: 'local', name: state.workspaceName || 'selected-folder' };
  if (state.backendMode === 'google' && googleDriveWorkspace.folderId) return { mode: 'google', name: googleDriveWorkspace.folderId };
  return null;
}

async function clearRecoveredDraft(id: string) {
  const workspace = recoveryWorkspace(useStore.getState());
  if (!workspace) return;
  await discardRecoveryDraft(workspace, id);
  useStore.setState(state => ({ recoveredDrafts: state.recoveredDrafts.filter(draft => draft.id !== id) }));
}

function cloneLabelIndex(source?: Record<string, string>): Record<string, string> {
  return Object.assign(Object.create(null), source || {});
}

function labelIndexWith(source: Record<string, string>, label: string, id: string): Record<string, string> {
  const next = cloneLabelIndex(source);
  next[label] = id;
  return next;
}

function normalizeBlocks(blocks: BlockData[]) {
  const blockOrder: string[] = [];
  const blocksById: Record<string, BlockData> = {};
  const blockIdByLabel = cloneLabelIndex();
  const workspaceIssues = findDuplicateLabelIssues(blocks.map(block => ({
    id: block.id,
    title: block.title,
    label: block.label,
    fileName: block._fileMeta?.fileName
  })));
  const duplicatedLabels = new Set(workspaceIssues.map(issue => issue.label));
  for (const block of blocks) {
    blockOrder.push(block.id);
    blocksById[block.id] = block;
    if (!duplicatedLabels.has(block.label)) blockIdByLabel[block.label] = block.id;
  }
  return { blockOrder, blocksById, blockIdByLabel, workspaceIssues };
}

function insertRestoredBlock(block: BlockData, index: number) {
  useStore.setState(state => {
    const without = state.blockOrder.filter(id => id !== block.id);
    without.splice(Math.min(Math.max(index, 0), without.length), 0, block.id);
    const blocksById = { ...state.blocksById, [block.id]: block };
    const normalized = normalizeBlocks(without.map(id => blocksById[id]).filter(Boolean));
    return {
      ...normalized,
      blocksRevision: state.blocksRevision + 1,
      persistenceError: null
    };
  });
}

async function ensureFullBlock(id: string): Promise<BlockData> {
  const current = useStore.getState().blocksById[id];
  if (!current) throw new Error('The note no longer exists.');
  if (current.content !== undefined) return { ...current };
  const loaded = await backendApi.loadBlockContent(id);
  if (!loaded) throw new Error(`Could not load “${current.title}” for undo history.`);
  return { ...current, ...loaded };
}

async function replayHistory(direction: HistoryDirection) {
  const source = direction === 'undo' ? undoEntries : redoEntries;
  const destination = direction === 'undo' ? redoEntries : undoEntries;
  const entry = source.at(-1);
  if (!entry || useStore.getState().historyState.busy) return;
  useStore.setState(state => ({ historyState: { ...state.historyState, busy: true }, historyRequest: null }));
  historyReplayInProgress = true;
  let rollback: (() => Promise<void>) | null = null;
  try {
    const store = useStore.getState();
    await store.flushPendingSaves();
    if (entry.kind === 'edit') {
      const expected = direction === 'undo' ? entry.after : entry.before;
      const replacement = direction === 'undo' ? entry.before : entry.after;
      const current = store.blocksById[entry.id];
      if (!current || current[entry.field] !== expected) throw new Error(`“${entry.title}” changed since this history step. Review it before trying again.`);
      store.updateBlock(entry.id, { [entry.field]: replacement });
      rollback = async () => { useStore.getState().updateBlock(entry.id, { [entry.field]: expected }); };
      await store.flushBlock(entry.id);
      if (failedBlockSaves.has(entry.id)) throw failedBlockSaves.get(entry.id);
    } else if (entry.kind === 'create' || entry.kind === 'delete') {
      const shouldExist = entry.kind === 'create' ? direction === 'undo' : direction === 'redo';
      if (entry.kind === 'create' && entry.linkedEdit) {
        const linked = useStore.getState().blocksById[entry.linkedEdit.id];
        const expected = direction === 'undo' ? entry.linkedEdit.after : entry.linkedEdit.before;
        if (!linked || linked.content !== expected) throw new Error('The note containing the new link changed. Review it before trying again.');
      }
      if (shouldExist) {
        const current = store.blocksById[entry.block.id];
        if (!current || current.title !== entry.block.title || current.label !== entry.block.label || current.content !== entry.block.content) {
          throw new Error(`“${entry.title}” changed since this history step. Review it before trying again.`);
        }
        await store.deleteBlock(entry.block.id);
        if (useStore.getState().blocksById[entry.block.id]) throw new Error(`Could not delete “${entry.title}”.`);
        rollback = async () => { insertRestoredBlock(await backendApi.restoreBlock(entry.block), entry.index); };
        if (entry.kind === 'create' && entry.linkedEdit) {
          useStore.getState().updateBlock(entry.linkedEdit.id, { content: entry.linkedEdit.before });
          rollback = async () => {
            insertRestoredBlock(await backendApi.restoreBlock(entry.block), entry.index);
            useStore.getState().updateBlock(entry.linkedEdit!.id, { content: entry.linkedEdit!.after });
          };
          await useStore.getState().flushBlock(entry.linkedEdit.id);
          if (failedBlockSaves.has(entry.linkedEdit.id)) throw failedBlockSaves.get(entry.linkedEdit.id);
        }
      } else {
        if (store.blocksById[entry.block.id] || Object.values(store.blocksById).some(block => block.label === entry.block.label)) {
          throw new Error(`The original ID or label for “${entry.title}” is already in use.`);
        }
        const restored = await backendApi.restoreBlock(entry.block);
        insertRestoredBlock(restored, entry.index);
        rollback = async () => { await useStore.getState().deleteBlock(entry.block.id); };
        if (entry.kind === 'create' && entry.linkedEdit) {
          useStore.getState().updateBlock(entry.linkedEdit.id, { content: entry.linkedEdit.after });
          rollback = async () => {
            useStore.getState().updateBlock(entry.linkedEdit!.id, { content: entry.linkedEdit!.before });
            await useStore.getState().deleteBlock(entry.block.id);
          };
          await useStore.getState().flushBlock(entry.linkedEdit.id);
          if (failedBlockSaves.has(entry.linkedEdit.id)) throw failedBlockSaves.get(entry.linkedEdit.id);
        }
      }
    } else if (entry.kind === 'repair') {
      const expected = direction === 'undo' ? entry.after : entry.before;
      const current = useStore.getState().blocksById[entry.id];
      if (!current || current.label !== expected) throw new Error('The repaired note changed since this history step.');
      const updated = direction === 'undo'
        ? await backendApi.undoDuplicateLabelRepair(entry.id, entry.after, entry.before)
        : await backendApi.repairDuplicateLabel(entry.id, entry.after);
      useStore.setState(state => {
        const blocksById = { ...state.blocksById, [entry.id]: { ...state.blocksById[entry.id], ...updated, content: state.blocksById[entry.id]?.content } };
        return { ...normalizeBlocks(state.blockOrder.map(id => blocksById[id]).filter(Boolean)), blocksRevision: state.blocksRevision + 1 };
      });
    } else if (entry.kind === 'relabel') {
      const expected = direction === 'undo' ? entry.after : entry.before;
      for (const id of entry.ids) {
        const current = await ensureFullBlock(id);
        const previous = expected[id];
        if (!previous || current.title !== previous.title || current.label !== previous.label || current.content !== previous.content) {
          throw new Error('A note affected by this rename changed. Review it before trying again.');
        }
      }
      const oldPrefix = direction === 'undo' ? entry.newPrefix : entry.oldPrefix;
      const newPrefix = direction === 'undo' ? entry.oldPrefix : entry.newPrefix;
      const plan = await store.previewRelabel(oldPrefix, newPrefix);
      if (plan.conflicts.length) throw new Error(plan.conflicts.join(' '));
      await store.commitRelabel(plan);
      const desired = direction === 'undo' ? entry.before : entry.after;
      for (const id of entry.ids) {
        const block = useStore.getState().blocksById[id];
        if (block && desired[id] && block.title !== desired[id].title) {
          useStore.getState().updateBlock(id, { title: desired[id].title });
        }
      }
      await useStore.getState().flushPendingSaves();
    } else {
      const expected = direction === 'undo' ? entry.after : entry.before;
      for (const id of entry.ids) {
        const current = await ensureFullBlock(id);
        if (current.content !== expected[id]) throw new Error('A note affected by this image move changed. Review it before trying again.');
      }
      const sourcePath = direction === 'undo' ? entry.destination : entry.source;
      const destinationPath = direction === 'undo' ? entry.source : entry.destination;
      const plan = await store.previewAssetMove(sourcePath, destinationPath);
      if (plan.conflicts.length) throw new Error(plan.conflicts.join(' '));
      await store.commitAssetMove(plan);
    }
    source.pop();
    rollback = null;
    destination.push(entry);
    useStore.setState(state => ({ historyState: {
      undoLabel: undoEntries.length ? historyLabel(undoEntries[undoEntries.length - 1]) : undefined,
      redoLabel: redoEntries.length ? historyLabel(redoEntries[redoEntries.length - 1]) : undefined,
      busy: false,
      replayRevision: state.historyState.replayRevision + 1
    } }));
  } catch (error) {
    let message = errorMessage(error);
    if (rollback) {
      try { await rollback(); }
      catch (rollbackError) { message += ` Rollback also failed: ${errorMessage(rollbackError)}`; }
    }
    useStore.setState(state => ({ persistenceError: message, historyState: {
      ...state.historyState, busy: false, replayRevision: state.historyState.replayRevision + 1
    } }));
  } finally {
    historyReplayInProgress = false;
    const queued = queuedHistoryDirection;
    queuedHistoryDirection = null;
    if (queued) queueMicrotask(() => {
      const store = useStore.getState();
      if (queued === 'undo') void store.historyUndo();
      else void store.historyRedo();
    });
  }
}

function resetEmbeddedWorkspaceCaches() {
  workspaceGeneration += 1;
  resetEmbeddedEditorLifecycle();
  resetEmbeddedPrefetchWorkspace();
}

function stopServerSync() {
  eventSource?.close();
  eventSource = null;
}

function prepareWorkspaceSwitch() {
  if (assetMoveInProgress) throw new Error('Finish the image move before changing workspaces.');
  clearHistory();
  resetEmbeddedWorkspaceCaches();
  resetImageResourceWorkspace();
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('math-note-workspace-reset'));
  stopServerSync();
  if (sessionSaveTimer) {
    clearTimeout(sessionSaveTimer);
    sessionSaveTimer = null;
  }
}

function emptyWorkspaceState(
  state: AppState,
  workspace: Pick<AppState, "backendMode" | "workspaceName" | "googleFolderName">
): Partial<AppState> {
  return {
    ...normalizeBlocks([]),
    blocksRevision: state.blocksRevision + 1,
    workspaceRevision: state.workspaceRevision + 1,
    isLoaded: false,
    activeBlockId: null,
    activePath: null,
    activeOccurrenceKey: null,
    activeFocusPos: null,
    activeFocusX: null,
    focusDirection: null,
    openTabs: [],
    activeTab: null,
    tabFocusStates: {},
    closedTabs: [],
    viewOnlyBlocks: {},
    viewerOriginalBlocks: {},
    viewerDraftBlockIds: {},
    blockLoadErrors: {},
    recoveredDrafts: [],
    settings: createDefaultEditorSettings(),
    persistenceError: null,
    ...workspace
  };
}

export function getOrderedBlocks(state: Pick<AppState, "blockOrder" | "blocksById">): BlockData[] {
  return state.blockOrder.map(id => state.blocksById[id]).filter((block): block is BlockData => !!block);
}

export function findNearestExistingParentId(label: string, blockIdByLabel: Record<string, string>): string | null {
  let separator = label.lastIndexOf('/');
  while (separator > 0) {
    const parentId = blockIdByLabel[label.slice(0, separator)];
    if (parentId) return parentId;
    separator = label.lastIndexOf('/', separator - 1);
  }
  return null;
}

function hasMetadataChange(current: BlockData, data: Partial<BlockData>) {
  return (data.title !== undefined && data.title !== current.title) ||
    (data.label !== undefined && data.label !== current.label) ||
    (data.hasContent !== undefined && data.hasContent !== current.hasContent) ||
    (data.references !== undefined && data.references !== current.references);
}

export const useStore = create<AppState>((set, get) => ({
  isLoaded: false,
  isLoadingFiles: false,
  blockOrder: [],
  blocksById: {},
  blockIdByLabel: cloneLabelIndex(),
  workspaceIssues: [],
  blocksRevision: 0,
  workspaceRevision: 0,
  activeBlockId: null,
  activePath: null,
  activeOccurrenceKey: null,
  activeFocusPos: null,
  activeFocusX: null,
  focusDirection: null,
  openTabs: [],
  activeTab: null,
  tabFocusStates: {},
  closedTabs: [],
  backendMode: "none",
  googleFolderName: null,
  workspaceName: null,
  viewOnlyBlocks: {},
  toggleViewOnly: (id) => set(state => {
    const current = state.viewOnlyBlocks[id] ?? (state.backendMode === "viewer");
    return { viewOnlyBlocks: { ...state.viewOnlyBlocks, [id]: !current } };
  }),
  viewerOriginalBlocks: {},
  viewerDraftBlockIds: {},
  resetViewerDrafts: () => { clearHistory(); set(state => {
    if (Object.keys(state.viewerDraftBlockIds).length === 0) return state;
    const blocksById = { ...state.blocksById };
    for (const id of Object.keys(state.viewerDraftBlockIds)) {
      const original = state.viewerOriginalBlocks[id];
      if (original) blocksById[id] = { ...original };
    }
    const normalized = normalizeBlocks(state.blockOrder.map(blockId => blocksById[blockId]).filter(Boolean));
    return {
      blocksById,
      blockIdByLabel: normalized.blockIdByLabel,
      workspaceIssues: normalized.workspaceIssues,
      viewerDraftBlockIds: {},
      blocksRevision: state.blocksRevision + 1,
      persistenceError: null
    };
  }); },
  imageUploadParams: null,
  setImageUploadParams: (params) => set({ imageUploadParams: params }),
  persistenceError: null,
  recoveredDrafts: [],
  reviewRecoveryDrafts: async () => {
    const workspace = recoveryWorkspace(get());
    if (!workspace) return;
    try {
      const warnings: string[] = [];
      const drafts = await loadRecoveryDrafts(workspace, warning => warnings.push(warning));
      for (const draft of drafts) lastRecoveryStamp = Math.max(lastRecoveryStamp, draft.updatedAt);
      const pending: RecoveryDraft[] = [];
      for (const draft of drafts) {
        const current = get().blocksById[draft.id];
        if (current) {
          try {
            const saved = await backendApi.loadBlockContent(draft.id);
            if (saved && saved.title === draft.title && saved.label === draft.label && saved.content === draft.content) {
              await discardRecoveryDraft(workspace, draft.id);
              continue;
            }
          } catch (error) { warnings.push(`Could not verify saved version of “${draft.title}”: ${errorMessage(error)}`); }
        }
        pending.push(draft);
      }
      set({ recoveredDrafts: pending, ...(warnings.length ? { persistenceError: warnings.join(' ') } : {}) });
    } catch (error) { set({ persistenceError: `Could not read recovery drafts: ${errorMessage(error)}` }); }
  },
  restoreRecoveryDraft: async id => {
    const draft = get().recoveredDrafts.find(item => item.id === id);
    if (!draft) return;
    try {
      if (dirtyBlockVersions.has(id)) throw new Error('This note has newer unsaved edits. Save or copy those edits before restoring the earlier draft.');
      const latest = await backendApi.loadBlockContent(id);
      if (!latest || !draft.baseRevision || latest.revision !== draft.baseRevision) throw new Error('The saved note changed or its version cannot be verified. Save this draft as a new note to keep both versions.');
      set(state => ({ blocksById: { ...state.blocksById, [id]: { ...state.blocksById[id], ...latest } } }));
      get().updateBlock(id, { title: draft.title, label: draft.label,
        ...(draft.content !== undefined ? { content: draft.content } : {}) });
      await get().flushBlock(id);
      if (failedBlockSaves.has(id)) throw failedBlockSaves.get(id);
      await clearRecoveredDraft(id);
      get().openBlockInTab(id, true);
    } catch (error) { set({ persistenceError: errorMessage(error) }); }
  },
  copyRecoveryDraft: async id => {
    const draft = get().recoveredDrafts.find(item => item.id === id);
    if (!draft) return;
    const baseLabel = Array.from(draft.label).length < MAX_BLOCK_LABEL_LENGTH - 30 ? draft.label : `recovered:${id}`;
    let label = `${baseLabel}/recovered`;
    let suffix = 2;
    while (get().blockIdByLabel[label]) label = `${baseLabel}/recovered-${suffix++}`;
    const titleSuffix = ' (recovered)';
    const title = `${Array.from(draft.title || 'Untitled note').slice(0, MAX_BLOCK_TITLE_LENGTH - titleSuffix.length).join('')}${titleSuffix}`;
    const copy = await get().addBlock({ title, label, content: draft.content || '' });
    if (!copy) return;
    try { await clearRecoveredDraft(id); get().openBlockInTab(copy.id, true); }
    catch (error) { set({ persistenceError: errorMessage(error) }); }
  },
  discardRecoveryDraft: async id => {
    try { await clearRecoveredDraft(id); }
    catch (error) { set({ persistenceError: errorMessage(error) }); }
  },
  blockLoadErrors: {},
  clearPersistenceError: () => set({ persistenceError: null }),
  historyState: { busy: false, replayRevision: 0 },
  historyRequest: null,
  actionRequest: null,
  separateNextEdit: () => { forceHistoryBoundary = true; },
  attachLastEditToCreate: (createdId) => {
    const latest = undoEntries.at(-1);
    const previous = undoEntries.at(-2);
    if (latest?.kind !== 'edit' || latest.field !== 'content' || previous?.kind !== 'create'
      || previous.block.id !== createdId || latest.at - previous.at > 5000) return;
    previous.linkedEdit = { id: latest.id, before: latest.before, after: latest.after };
    undoEntries.pop();
    trimHistory();
    updateHistoryState();
  },
  historyUndo: async () => {
    if (get().historyState.busy) { queuedHistoryDirection = 'undo'; return; }
    if (confirmedActionInProgress || get().historyRequest || get().actionRequest) return;
    const entry = undoEntries.at(-1);
    if (!entry) return;
    const crossTab = !!entry.ownerTab && entry.ownerTab !== get().activeTab;
    if (entry.kind !== 'edit' || entry.field === 'title' || crossTab) {
      set({ historyRequest: {
        direction: 'undo', label: historyLabel(entry), crossTab,
        affectedNotes: historyAffectedNotes(entry, get().blocksById), change: historyChange(entry, 'undo'),
        special: entry.kind !== 'edit' || entry.field === 'title'
      } });
      return;
    }
    await replayHistory('undo');
  },
  historyRedo: async () => {
    if (get().historyState.busy) { queuedHistoryDirection = 'redo'; return; }
    if (confirmedActionInProgress || get().historyRequest || get().actionRequest) return;
    const entry = redoEntries.at(-1);
    if (!entry) return;
    const crossTab = !!entry.ownerTab && entry.ownerTab !== get().activeTab;
    if (entry.kind !== 'edit' || entry.field === 'title' || crossTab) {
      set({ historyRequest: {
        direction: 'redo', label: historyLabel(entry), crossTab,
        affectedNotes: historyAffectedNotes(entry, get().blocksById), change: historyChange(entry, 'redo'),
        special: entry.kind !== 'edit' || entry.field === 'title'
      } });
      return;
    }
    await replayHistory('redo');
  },
  confirmHistoryRequest: async () => {
    const request = get().historyRequest;
    if (!request) return;
    set({ historyRequest: null });
    await replayHistory(request.direction);
  },
  cancelHistoryRequest: () => set({ historyRequest: null }),
  requestWorkspaceAction: (label, detail, run, details) => new Promise<boolean>(resolve => {
    if (confirmedActionInProgress || get().historyState.busy || get().actionRequest || get().historyRequest) { resolve(false); return; }
    pendingAction = { run, resolve };
    set({ actionRequest: { label, detail, ...details } });
  }),
  confirmWorkspaceAction: async () => {
    const action = pendingAction;
    if (!action) return;
    pendingAction = null;
    set({ actionRequest: null });
    confirmedActionInProgress = true;
    try {
      await action.run();
      action.resolve(true);
    } catch (error) {
      set({ persistenceError: errorMessage(error) });
      action.resolve(false);
    } finally {
      confirmedActionInProgress = false;
    }
  },
  cancelWorkspaceAction: () => {
    const action = pendingAction;
    pendingAction = null;
    set({ actionRequest: null });
    action?.resolve(false);
  },
  settings: createDefaultEditorSettings({ "\\R": "\\mathbb{R}", "\\N": "\\mathbb{N}" }),
  assetRevision: 0,
  saveAsset: async (file: File, filename: string, overwrite = false) => {
    const path = await backendApi.saveAsset(file, filename, overwrite);
    invalidateImageAsset(path);
    set(state => ({ assetRevision: state.assetRevision + 1 }));
    return path;
  },
  listAssets: async () => {
    return await backendApi.listAssets();
  },
  getAssetUrl: async (path: string) => {
    return await backendApi.getAssetUrl(path);
  },
  previewAssetMove: async (source, destination) => {
    await get().flushPendingSaves();
    return backendApi.previewAssetMove(source, destination);
  },
  commitAssetMove: async (plan) => {
    if (assetMoveInProgress) throw new Error('Another image move is still running.');
    if (workspaceSwitchInProgress) throw new Error('Finish changing workspaces before moving an image.');
    assetMoveInProgress = true;
    try {
      await get().flushPendingSaves();
      const before = Object.fromEntries(await Promise.all(plan.impacts.map(async impact => [impact.blockId, (await ensureFullBlock(impact.blockId)).content || ''] as const)));
      let result: Awaited<ReturnType<typeof backendApi.commitAssetMove>>;
      try { result = await backendApi.commitAssetMove(plan); }
      catch (error) {
        await get().loadBlocks();
        set(state => ({ assetRevision: state.assetRevision + 1 }));
        throw error;
      }
      invalidateImageAsset(result.plan.source);
      invalidateImageAsset(result.plan.destination);
      set(state => {
        const blocksById = { ...state.blocksById };
        for (const updated of result.updatedBlocks) {
          const current = blocksById[updated.id];
          if (current) blocksById[updated.id] = { ...current, content: updated.content,
            hasContent: updated.hasContent, references: updated.references, revision: updated.revision ?? current.revision };
        }
        return { blocksById, assetRevision: state.assetRevision + 1,
          blocksRevision: state.blocksRevision + 1, persistenceError: null };
      });
      pushHistory({ kind: 'assetMove', source: result.plan.source, destination: result.plan.destination,
        ids: result.plan.impacts.map(impact => impact.blockId), before,
        after: Object.fromEntries(result.updatedBlocks.map(block => [block.id, block.content || ''])), title: result.plan.source,
        ownerTab: get().activeTab, at: Date.now() });
      return result.warning;
    } finally { assetMoveInProgress = false; }
  },
  initBackend: async () => {
    if (get().isLoaded && backendApi.mode === 'server' && dirtyBlockVersions.size > 0) {
      try {
        // Reconnect must not replace an unsaved paste with the disk version.
        await get().flushPendingSaves();
      } catch (error) {
        set({ persistenceError: `Could not reconnect without losing unsaved changes: ${errorMessage(error)}` });
        return;
      }
    }
    await backendApi.init();
    let workspaceName: string | null = null;
    if (backendApi.mode === 'server') {
      try {
        const response = await fetch('/api/runtime');
        if (response.ok) workspaceName = (await response.json()).workspaceName || null;
      } catch { /* The server can still load notes without a workspace label. */ }
    }
    set({ backendMode: backendApi.mode, workspaceName });
    if (backendApi.mode !== "none") {
      await get().loadBlocks();
      await get().loadSettings();
      await get().reviewRecoveryDrafts();
      get().initSync();
    }
    set({ isLoaded: true });
  },

  loadViewerFiles: async (files: FileList) => {
    // The input is cleared after this handler starts; keep its files before awaiting.
    const selectedFiles = Array.from(files);
    set({ isLoadingFiles: true });
    let beganSwitch = false;
    try {
    beginWorkspaceSwitch();
    beganSwitch = true;
    await get().flushPendingSaves();
    const newBlocks: BlockData[] = [];
    let loadedSettings: any = null;
    for (const file of selectedFiles) {
      if (file.name.endsWith('.md')) {
        const text = await file.text();
        const { data, content } = parseFrontmatter(text);
        const id = data.id || file.name.replace('.md', '');
        newBlocks.push({
          id: metadataText(id),
          title: normalizeBlockTitle(metadataText(data.title)),
          label: normalizeBlockLabel(metadataText(data.label)),
          references: computeReferences(content),
          content,
          hasContent: content.trim().length > 0,
          _fileMeta: { fileName: file.webkitRelativePath || file.name }
        });
      } else if (file.name === 'settings.json' && file.webkitRelativePath.includes('/setting/')) {
        try {
          loadedSettings = JSON.parse(await file.text());
        } catch (e) {}
      }
    }
    
    if (backendApi.mode === 'google') await backendApi.disconnectGoogleDrive();
    backendApi.setViewerFiles(selectedFiles);
    backendApi.mode = 'viewer';
    const firstPath = selectedFiles[0]?.webkitRelativePath || '';
    const workspaceName = firstPath.split('/')[0] || 'Selected folder';
    prepareWorkspaceSwitch();
    set(state => ({
      ...emptyWorkspaceState(state, { backendMode: 'viewer', workspaceName, googleFolderName: null }),
      ...normalizeBlocks(newBlocks),
      viewerOriginalBlocks: Object.fromEntries(newBlocks.map(block => [block.id, { ...block }])),
      viewerDraftBlockIds: {},
      isLoaded: true,
      blockLoadErrors: {}
    }));
    await get().loadSettings();
    
    if (loadedSettings) {
      const validIds = new Set(newBlocks.map(block => block.id));
      const openTabs = (loadedSettings.workspaceSession?.openTabs || []).filter((id: unknown): id is string => typeof id === 'string' && validIds.has(id));
      const activeTab = openTabs.includes(loadedSettings.workspaceSession?.activeTab) ? loadedSettings.workspaceSession.activeTab : openTabs[0] || null;
      set(state => ({ settings: { ...state.settings, ...loadedSettings }, openTabs, activeTab }));
    }
    
    // Auto-open first tab if any
    if (newBlocks.length > 0 && get().openTabs.length === 0) {
      set({ openTabs: [newBlocks[0].id], activeTab: newBlocks[0].id });
    }
    } catch (error) {
      set({ persistenceError: errorMessage(error) });
    } finally {
      if (beganSwitch) workspaceSwitchInProgress = false;
      set({ isLoadingFiles: false });
    }
  },

  connectLocalFS: async () => {
    set({ isLoadingFiles: true });
    let beganSwitch = false;
    try {
      beginWorkspaceSwitch();
      beganSwitch = true;
      const success = await backendApi.connectLocalFS(async () => {
        if (assetMoveInProgress) throw new Error('Finish the image move before changing workspaces.');
        await get().flushPendingSaves();
        if (assetMoveInProgress) throw new Error('Finish the image move before changing workspaces.');
      });
      if (success) {
        prepareWorkspaceSwitch();
        set(state => emptyWorkspaceState(state, {
          backendMode: backendApi.mode,
          workspaceName: backendApi.localFolderName,
          googleFolderName: null
        }));
        await get().loadBlocks();
        await get().loadSettings();
        await get().reviewRecoveryDrafts();
        set({ isLoaded: true });
      }
    } catch (error) {
      set({ persistenceError: errorMessage(error) });
    } finally {
      if (beganSwitch) workspaceSwitchInProgress = false;
      set({ isLoadingFiles: false });
    }
  },
  connectGoogleDrive: async () => {
    set({ isLoadingFiles: true, persistenceError: null });
    let beganSwitch = false;
    try {
      beginWorkspaceSwitch();
      beganSwitch = true;
      const selected = await backendApi.connectGoogleDrive(async () => {
        if (assetMoveInProgress) throw new Error('Finish the image move before changing workspaces.');
        await get().flushPendingSaves();
        if (assetMoveInProgress) throw new Error('Finish the image move before changing workspaces.');
      });
      prepareWorkspaceSwitch();
      set(state => emptyWorkspaceState(state, {
        backendMode: 'google',
        googleFolderName: selected.name,
        workspaceName: selected.name
      }));
      await get().loadBlocks();
      await get().loadSettings();
      await get().reviewRecoveryDrafts();
      const first = get().blockOrder[0];
      if (first && get().openTabs.length === 0) set({ openTabs: [first], activeTab: first });
      set({ isLoaded: true });
    } catch (error) {
      set({ persistenceError: errorMessage(error) });
    } finally {
      if (beganSwitch) workspaceSwitchInProgress = false;
      set({ isLoadingFiles: false });
    }
  },
  disconnectGoogleDrive: async () => {
    let beganSwitch = false;
    try {
      beginWorkspaceSwitch();
      beganSwitch = true;
      await get().flushPendingSaves();
      await backendApi.disconnectGoogleDrive();
      prepareWorkspaceSwitch();
      set(state => emptyWorkspaceState(state, {
        backendMode: 'none',
        googleFolderName: null,
        workspaceName: null
      }));
    } catch (error) {
      set({ persistenceError: errorMessage(error) });
    } finally { if (beganSwitch) workspaceSwitchInProgress = false; }
  },
  loadSettings: async (preserveSession = false) => {
    const generation = workspaceGeneration;
    try {
      const data = await backendApi.loadSettings();
      if (generation !== workspaceGeneration) return;
      if (data) {
        const normalized = normalizeEditorSettings(data, createDefaultEditorSettings());
        const safeData = normalized.settings;
        if (normalized.issues.length) set({ persistenceError: `Some workspace preferences are invalid and were ignored: ${normalized.issues.join(' ')}` });
        if (preserveSession) {
          set({ settings: safeData });
          return;
        }
        const validIds = new Set(get().blockOrder);
        const openTabs = (safeData.workspaceSession?.openTabs || []).filter((id: unknown): id is string => typeof id === 'string' && validIds.has(id));
        const activeTab = openTabs.includes(safeData.workspaceSession?.activeTab || '') ? safeData.workspaceSession!.activeTab : openTabs[0] || null;
        const lockedTabs = (safeData.workspaceSession?.lockedTabs || []).filter((id: unknown): id is string => typeof id === 'string' && validIds.has(id));
        set({
          settings: safeData,
          openTabs,
          activeTab,
          viewOnlyBlocks: Object.fromEntries(lockedTabs.map(id => [id, true]))
        });
      }
    } catch (e) {
      if (generation !== workspaceGeneration) return;
      console.warn("Failed to load settings", e);
      set({ persistenceError: `Could not load workspace settings: ${errorMessage(e)}` });
    }
  },
  saveSettings: async (settings) => {
    const previousSettings = get().settings;
    const settingsWithSession = {
      ...settings,
      workspaceSession: {
        openTabs: get().openTabs,
        activeTab: get().activeTab,
        lockedTabs: Object.entries(get().viewOnlyBlocks).filter(([, locked]) => locked).map(([id]) => id)
      }
    };
    try {
      const issues = validateEditorSettings(settingsWithSession);
      if (issues.length) throw new Error(issues.join(' '));
      set({ settings: settingsWithSession, persistenceError: null });
      await backendApi.saveSettings(settingsWithSession);
      return true;
    } catch (e) {
      console.warn("Failed to save settings", e);
      set({ settings: previousSettings, persistenceError: errorMessage(e) });
      return false;
    }
  },
  listBackups: () => backendApi.listBackups(),
  restoreBackup: async (path) => {
    await get().flushPendingSaves();
    await backendApi.restoreBackup(path);
    clearHistory();
    await get().loadBlocks();
    if (path === 'setting/settings.json') await get().loadSettings();
  },
  loadBlocks: async () => {
    const generation = workspaceGeneration;
    try {
      const blocks = await backendApi.loadBlocks();
      if (generation !== workspaceGeneration) return;
      set(state => ({
        ...normalizeBlocks(blocks),
        blocksRevision: state.blocksRevision + 1,
        persistenceError: null
      }));
    } catch (e) {
      if (generation !== workspaceGeneration) return;
      console.warn("Failed to load blocks", e);
      set({ persistenceError: errorMessage(e) });
    }
  },
  loadBlockContent: async (id: string) => {
    const generation = workspaceGeneration;
    try {
      const block = get().blocksById[id];
      if (block && block.content !== undefined) return; // already loaded
      set(state => {
        if (!state.blockLoadErrors[id]) return state;
        const blockLoadErrors = { ...state.blockLoadErrors };
        delete blockLoadErrors[id];
        return { blockLoadErrors };
      });
      const fullBlock = await backendApi.loadBlockContent(id);
      if (generation !== workspaceGeneration) return;
      if (!fullBlock) throw new Error('The embedded note could not be found.');
      set(state => {
        const current = state.blocksById[id];
        if (!current || current.content !== undefined) return state;
        const blockLoadErrors = { ...state.blockLoadErrors };
        delete blockLoadErrors[id];
        return {
          blocksById: {
            ...state.blocksById,
            [id]: { ...current, content: fullBlock.content, revision: fullBlock.revision || current.revision }
          },
          blockLoadErrors
        };
      });
    } catch (e) {
      if (generation !== workspaceGeneration) return;
      console.warn("Failed to load block content", e);
      const message = errorMessage(e);
      set(state => ({
        blockLoadErrors: { ...state.blockLoadErrors, [id]: message }
      }));
      throw e;
    }
  },
  addBlock: async (data) => {
    const title = normalizeBlockTitle(metadataText(data?.title, 'New Block'));
    let baseLabel = normalizeBlockLabel(metadataText(data?.label, 'block'));
    const metadataError = validateBlockMetadata(title, baseLabel);
    if (metadataError) {
      set({ persistenceError: metadataError });
      return;
    }
    let label = baseLabel;
    
    const { blocksById } = get();
    const labelExists = Object.values(blocksById).some(block => block.label === label);
    if ((labelExists || pendingBlockLabels.has(label)) && data?.label !== undefined) {
        set({ persistenceError: `Label "${label}" already exists` });
        return;
    }
    if (labelExists || pendingBlockLabels.has(label)) {
      let counter = 1;
      while (Object.values(blocksById).some(block => block.label === `${baseLabel}-${counter}`)
        || pendingBlockLabels.has(`${baseLabel}-${counter}`)) {
        counter++;
      }
        label = `${baseLabel}-${counter}`;
    }

    const newBlockData = { ...data, title, label, content: data?.content || '' };
    pendingBlockLabels.add(label);
    try {
      const newBlock = await backendApi.addBlock(newBlockData);
      
      set((state) => {
        const withoutNew = state.blockOrder.filter(id => id !== newBlock.id);
        const blockOrder = [...withoutNew, newBlock.id];
        return {
          blockOrder,
          blocksById: { ...state.blocksById, [newBlock.id]: newBlock },
          blockIdByLabel: labelIndexWith(state.blockIdByLabel, newBlock.label, newBlock.id),
          blocksRevision: state.blocksRevision + 1,
          persistenceError: null
        };
      });
      pushHistory({ kind: 'create', block: { ...newBlock }, index: get().blockOrder.indexOf(newBlock.id),
        title: newBlock.title, ownerTab: get().activeTab, at: Date.now() });
      return newBlock;
    } catch (e) {
      console.warn("Failed to add block", e);
      set({ persistenceError: errorMessage(e) });
    } finally {
      pendingBlockLabels.delete(label);
    }
  },
  updateBlock: (id, data) => {
    const current = get().blocksById[id];
    if (!current) return;
    const normalizedData = { ...data };
    if (data.content !== undefined) {
      const references = computeReferences(data.content);
      const currentReferences = current.references || [];
      if (references.length !== currentReferences.length || references.some((reference, index) => reference !== currentReferences[index])) {
        normalizedData.references = references;
      }
      normalizedData.hasContent = data.content.trim().length > 0;
    }
    if (data.title !== undefined) {
      normalizedData.title = normalizeBlockTitle(metadataText(data.title));
      const titleError = validateBlockTitle(normalizedData.title);
      if (titleError) {
        set({ persistenceError: titleError });
        return;
      }
    }
    if (data.label !== undefined) {
      normalizedData.label = normalizeBlockLabel(metadataText(data.label));
      const labelError = validateBlockLabel(normalizedData.label);
      const duplicateId = Object.values(get().blocksById).find(block => block.id !== id && block.label === normalizedData.label)?.id;
      if (labelError || duplicateId) {
        set({ persistenceError: labelError || `Label "${normalizedData.label}" already exists` });
        return;
      }
    }
    data = normalizedData;
    const hasActualChange = Object.entries(data).some(([key, value]) =>
      (current as unknown as Record<string, unknown>)[key] !== value
    );
    if (!hasActualChange) return;
    if (get().backendMode === 'viewer') {
      set((state) => {
        const current = state.blocksById[id];
        if (!current) return state;
        const next = { ...current, ...data };
        return {
          blocksById: { ...state.blocksById, [id]: next },
          viewerDraftBlockIds: { ...state.viewerDraftBlockIds, [id]: true },
          blocksRevision: hasMetadataChange(current, data) ? state.blocksRevision + 1 : state.blocksRevision,
          persistenceError: null
        };
      });
      if (data.content !== undefined && data.content !== current.content) {
        pushHistory({ kind: 'edit', id, field: 'content', before: current.content || '', after: data.content,
          title: current.title, ownerTab: get().activeTab, at: Date.now() });
      }
      if (data.title !== undefined && data.title !== current.title) {
        pushHistory({ kind: 'edit', id, field: 'title', before: current.title, after: data.title,
          title: current.title, ownerTab: get().activeTab, at: Date.now() });
      }
      return;
    }
    set((state) => {
      const current = state.blocksById[id];
      if (!current) return state;
      const next = { ...current, ...data };
      const metadataChanged = hasMetadataChange(current, data);
      let blockIdByLabel = state.blockIdByLabel;
      if (data.label !== undefined && data.label !== current.label) {
        blockIdByLabel = cloneLabelIndex(state.blockIdByLabel);
        if (blockIdByLabel[current.label] === id) delete blockIdByLabel[current.label];
        blockIdByLabel[data.label] = id;
      }
      return {
        blocksById: { ...state.blocksById, [id]: next },
        blockIdByLabel,
        blocksRevision: metadataChanged ? state.blocksRevision + 1 : state.blocksRevision
      };
    });

    if (data.content !== undefined && data.content !== current.content) {
      pushHistory({ kind: 'edit', id, field: 'content', before: current.content || '', after: data.content,
        title: current.title, ownerTab: get().activeTab, at: Date.now() });
    }
    if (data.title !== undefined && data.title !== current.title) {
      pushHistory({ kind: 'edit', id, field: 'title', before: current.title, after: data.title,
        title: current.title, ownerTab: get().activeTab, at: Date.now() });
    }

    const workspace = recoveryWorkspace(get());
    if (workspace) {
      const draft = get().blocksById[id];
      try {
        lastRecoveryStamp = Math.max(Date.now(), lastRecoveryStamp + 1);
        saveRecoveryDraft(workspace, { id, title: draft.title, label: draft.label, content: draft.content,
          baseRevision: current.revision, updatedAt: lastRecoveryStamp },
          error => set({ persistenceError: `Could not save recovery draft: ${errorMessage(error)}` }));
      } catch (error) { set({ persistenceError: `Could not save recovery draft: ${errorMessage(error)}` }); }
    }
    dirtyBlockVersions.set(id, (dirtyBlockVersions.get(id) || 0) + 1);
    scheduleBlockSave(id);
  },
  flushBlock: async (id) => {
    await flushBlockSave(id);
  },
  flushPendingSaves: async () => {
    // A save already in flight can receive a newer local version just as its
    // request completes. Keep draining until the workspace is actually stable;
    // otherwise preview may be built before that newer version reaches disk and
    // commit will correctly-but-confusingly reject its own first confirmation.
    for (let attempt = 0; attempt < 20 && dirtyBlockVersions.size > 0; attempt++) {
      const pendingIds = Array.from(dirtyBlockVersions.keys());
      await Promise.all(pendingIds.map(id => flushBlockSave(id)));
      const failure = pendingIds.map(id => failedBlockSaves.get(id)).find(Boolean);
      if (failure) throw failure;
      if (dirtyBlockVersions.size > 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    if (dirtyBlockVersions.size > 0) {
      throw new Error('Could not save all pending block edits before preparing the tree transformation.');
    }
    await persistWorkspaceSession();
  },
  previewRelabel: async (oldPrefix, newPrefix) => {
    await get().flushPendingSaves();
    return await backendApi.previewRelabel(oldPrefix, newPrefix);
  },
  commitRelabel: async (plan) => {
    await get().flushPendingSaves();
    const affectedIds = [...new Set([
      ...plan.blockChanges.map(change => change.id),
      ...plan.referenceImpacts.filter(impact => impact.changed).map(impact => impact.blockId)
    ])];
    const before = Object.fromEntries(await Promise.all(affectedIds.map(async id => [id, await ensureFullBlock(id)] as const)));
    let result: Awaited<ReturnType<typeof backendApi.commitRelabel>>;
    try { result = await backendApi.commitRelabel(plan); }
    catch (error) {
      await get().loadBlocks();
      throw error;
    }
    set(state => {
      const blocksById = { ...state.blocksById };
      const labelMap = new Map<string, string>();
      for (const change of result.plan.blockChanges) labelMap.set(change.oldLabel, change.newLabel);
      for (const updated of result.updatedBlocks) {
        const current = blocksById[updated.id];
        if (!current) continue;
        blocksById[updated.id] = {
          ...current,
          label: updated.label,
          title: updated.title,
          references: updated.references,
          revision: updated.revision ?? current.revision,
          hasContent: updated.hasContent,
          ...(current.content !== undefined ? { content: updated.content } : {})
        };
      }
      const normalized = normalizeBlocks(state.blockOrder.map(id => blocksById[id]).filter(Boolean));
      const remapPath = (path: string[] | null) => path?.map(label => labelMap.get(label) || label) || null;
      const tabFocusStates = Object.fromEntries(Object.entries(state.tabFocusStates).map(([id, focus]) => [id, {
        ...focus,
        activePath: remapPath(focus.activePath)
      }]));
      return {
        blocksById,
        blockIdByLabel: normalized.blockIdByLabel,
        workspaceIssues: normalized.workspaceIssues,
        blocksRevision: state.blocksRevision + 1,
        activePath: remapPath(state.activePath),
        tabFocusStates,
        persistenceError: null
      };
    });
    const after = Object.fromEntries(result.updatedBlocks.map(block => [block.id, { ...block }]));
    pushHistory({ kind: 'relabel', oldPrefix: result.plan.oldPrefix, newPrefix: result.plan.newPrefix,
      ids: affectedIds, before, after, title: result.plan.oldPrefix,
      ownerTab: get().activeTab, at: Date.now() });
  },
  repairDuplicateLabel: async (id, newLabel) => {
    try {
      await get().flushBlock(id);
      const previous = get().blocksById[id];
      const updated = await backendApi.repairDuplicateLabel(id, newLabel);
      set(state => {
        const current = state.blocksById[id];
        if (!current) return state;
        const blocksById = { ...state.blocksById, [id]: { ...current, ...updated, content: current.content } };
        const normalized = normalizeBlocks(state.blockOrder.map(blockId => blocksById[blockId]).filter(Boolean));
        const remapPath = (value: string[] | null) => value?.map(label => label === current.label ? updated.label : label) || null;
        const tabFocusStates = Object.fromEntries(Object.entries(state.tabFocusStates).map(([tabId, focus]) => [tabId, {
          ...focus,
          activePath: remapPath(focus.activePath)
        }]));
        return {
          blocksById,
          blockIdByLabel: normalized.blockIdByLabel,
          workspaceIssues: normalized.workspaceIssues,
          blocksRevision: state.blocksRevision + 1,
          activePath: remapPath(state.activePath),
          tabFocusStates,
          persistenceError: null
        };
      });
      if (previous) pushHistory({ kind: 'repair', id, before: previous.label, after: updated.label,
        title: previous.title, ownerTab: get().activeTab, at: Date.now() });
      return true;
    } catch (e) {
      set({ persistenceError: errorMessage(e) });
      return false;
    }
  },
  deleteBlock: async (id) => {
    await get().flushBlock(id);
    if (failedBlockSaves.has(id)) throw failedBlockSaves.get(id);
    const originalIndex = get().blockOrder.indexOf(id);
    const ownerTab = get().activeTab;
    const original = originalIndex >= 0 ? await ensureFullBlock(id) : null;
    dirtyBlockVersions.delete(id);
    try {
      await backendApi.deleteBlock(id, original?.revision);
      set((state) => {
        const idx = state.blockOrder.indexOf(id);
        if (idx === -1) return state;
        const blockOrder = state.blockOrder.filter(blockId => blockId !== id);
        const blocksById = { ...state.blocksById };
        const removed = blocksById[id];
        delete blocksById[id];
        const normalized = normalizeBlocks(blockOrder.map(blockId => blocksById[blockId]).filter(Boolean));
        const openTabs = state.openTabs.filter(tabId => tabId !== id);
        const activeTab = state.activeTab === id ? (openTabs.at(-1) || null) : state.activeTab;
        const activeBlockId = state.activeBlockId === id ? activeTab : state.activeBlockId;
        const activeBlock = activeBlockId ? blocksById[activeBlockId] : undefined;
        const rootFocusChanged = state.activeBlockId === id;
        return {
          blockOrder,
          blocksById,
          blockIdByLabel: normalized.blockIdByLabel,
          workspaceIssues: normalized.workspaceIssues,
          blocksRevision: state.blocksRevision + 1,
          openTabs,
          closedTabs: state.closedTabs.filter(tab => tab.id !== id),
          activeTab,
          activeBlockId,
          activePath: rootFocusChanged ? (activeBlock ? [activeBlock.label] : null) : state.activePath,
          activeOccurrenceKey: rootFocusChanged ? null : state.activeOccurrenceKey,
          activeFocusPos: rootFocusChanged ? null : state.activeFocusPos,
          activeFocusX: rootFocusChanged ? null : state.activeFocusX,
          focusDirection: rootFocusChanged ? "start" : state.focusDirection,
          persistenceError: null
        };
      });
      try { await clearRecoveredDraft(id); }
      catch (error) { set({ persistenceError: `Note deleted, but its recovery draft could not be cleared: ${errorMessage(error)}` }); }
      if (original) pushHistory({ kind: 'delete', block: original, index: originalIndex,
        title: original.title, ownerTab, at: Date.now() });
    } catch (e) {
      console.warn("Failed to delete block", e);
      set({ persistenceError: errorMessage(e) });
    }
  },
  setActiveBlock: (id, dir, path, pos, x, occurrenceKey) => set(state => {
    const focusState = {
      activeBlockId: id,
      focusDirection: dir || null,
      activePath: path || null,
      activeOccurrenceKey: occurrenceKey ?? null,
      activeFocusPos: pos ?? null,
      activeFocusX: x ?? null
    };
    return {
      ...focusState,
      tabFocusStates: state.activeTab
        ? { ...state.tabFocusStates, [state.activeTab]: focusState }
        : state.tabFocusStates
    };
  }),
  setSettings: (settings) => set({ settings }),
  setOpenTabs: (tabs) => set({ openTabs: tabs }),
  setActiveTab: (id) => set({ activeTab: id }),
  activateTab: (id) => set((state) => {
    const block = state.blocksById[id];
    if (!block || !state.openTabs.includes(id)) return state;
    const outgoing = state.activeTab ? {
      activeBlockId: state.activeBlockId,
      activePath: state.activePath,
      activeOccurrenceKey: state.activeOccurrenceKey,
      activeFocusPos: state.activeFocusPos,
      activeFocusX: state.activeFocusX,
      focusDirection: state.focusDirection
    } : null;
    const tabFocusStates = outgoing && state.activeTab
      ? { ...state.tabFocusStates, [state.activeTab]: outgoing }
      : state.tabFocusStates;
    const restored = tabFocusStates[id] || {
      activeBlockId: id,
      activePath: [block.label],
      activeOccurrenceKey: null,
      activeFocusPos: null,
      activeFocusX: null,
      focusDirection: null
    };
    return { activeTab: id, tabFocusStates, ...restored, focusDirection: null };
  }),
  closeTab: async (id) => {
    await get().flushPendingSaves();
    set(state => {
      const index = state.openTabs.indexOf(id);
      if (index < 0) return state;
      const openTabs = state.openTabs.filter(tabId => tabId !== id);
      const activeFocusState: TabFocusState = {
        activeBlockId: state.activeBlockId,
        activePath: state.activePath,
        activeOccurrenceKey: state.activeOccurrenceKey,
        activeFocusPos: state.activeFocusPos,
        activeFocusX: state.activeFocusX,
        focusDirection: state.focusDirection
      };
      const focusState = state.activeTab === id ? activeFocusState : state.tabFocusStates[id];
      const closedTabs = [
        { id, index, focusState },
        ...state.closedTabs.filter(tab => tab.id !== id)
      ].slice(0, 20);
      const tabFocusStates = { ...state.tabFocusStates };
      delete tabFocusStates[id];
      if (state.activeTab !== id) return { openTabs, tabFocusStates, closedTabs };
      const fallback = openTabs[index] || openTabs[index - 1] || null;
      if (!fallback) return {
        openTabs,
        tabFocusStates,
        closedTabs,
        activeTab: null,
        activeBlockId: null,
        activePath: null,
        activeOccurrenceKey: null,
        activeFocusPos: null,
        activeFocusX: null,
        focusDirection: null
      };
      const block = state.blocksById[fallback];
      const restored = tabFocusStates[fallback] || {
        activeBlockId: fallback,
        activePath: block ? [block.label] : null,
        activeOccurrenceKey: null,
        activeFocusPos: null,
        activeFocusX: null,
        focusDirection: null
      };
      return { openTabs, tabFocusStates, closedTabs, activeTab: fallback, ...restored, focusDirection: null };
    });
  },
  reopenClosedTab: () => set(state => {
    const [closed, ...remaining] = state.closedTabs;
    if (!closed) return state;
    const block = state.blocksById[closed.id];
    if (!block) return { closedTabs: remaining };
    if (state.openTabs.includes(closed.id)) return { closedTabs: remaining };
    const openTabs = [...state.openTabs];
    openTabs.splice(Math.min(closed.index, openTabs.length), 0, closed.id);
    const restored = closed.focusState || {
      activeBlockId: closed.id,
      activePath: [block.label],
      activeOccurrenceKey: null,
      activeFocusPos: null,
      activeFocusX: null,
      focusDirection: null
    };
    return {
      openTabs,
      closedTabs: remaining,
      activeTab: closed.id,
      tabFocusStates: { ...state.tabFocusStates, [closed.id]: restored },
      ...restored,
      focusDirection: null
    };
  }),
  cycleTab: (direction) => set(state => {
    if (state.openTabs.length < 2) return state;
    const currentIndex = Math.max(0, state.activeTab ? state.openTabs.indexOf(state.activeTab) : 0);
    const nextIndex = (currentIndex + direction + state.openTabs.length) % state.openTabs.length;
    const id = state.openTabs[nextIndex];
    const block = state.blocksById[id];
    if (!block) return state;
    const outgoing = state.activeTab ? {
      activeBlockId: state.activeBlockId,
      activePath: state.activePath,
      activeOccurrenceKey: state.activeOccurrenceKey,
      activeFocusPos: state.activeFocusPos,
      activeFocusX: state.activeFocusX,
      focusDirection: state.focusDirection
    } : null;
    const tabFocusStates = outgoing && state.activeTab
      ? { ...state.tabFocusStates, [state.activeTab]: outgoing }
      : state.tabFocusStates;
    const restored = tabFocusStates[id] || {
      activeBlockId: id,
      activePath: [block.label],
      activeOccurrenceKey: null,
      activeFocusPos: null,
      activeFocusX: null,
      focusDirection: null
    };
    return { activeTab: id, tabFocusStates, ...restored, focusDirection: null };
  }),
  goToNearestParent: () => {
    const state = get();
    const root = state.activeTab ? state.blocksById[state.activeTab] : null;
    if (!root) return false;
    const parentId = findNearestExistingParentId(root.label, state.blockIdByLabel);
    if (!parentId) return false;
    state.openBlockNextToActive(parentId);
    return true;
  },
  activateRootBlock: (id, dir = null) => set((state) => {
    const block = state.blocksById[id];
    if (!block) return state;
    const focusState = {
      activeBlockId: id,
      activePath: [block.label],
      activeOccurrenceKey: null,
      activeFocusPos: null,
      activeFocusX: null,
      focusDirection: dir
    };
    return {
      openTabs: state.openTabs.includes(id) ? state.openTabs : [...state.openTabs, id],
      closedTabs: state.closedTabs.filter(tab => tab.id !== id),
      activeTab: id,
      ...focusState,
      tabFocusStates: { ...state.tabFocusStates, [id]: focusState }
    };
  }),
  openBlockInTab: (id, activate) => {
    if (activate) {
      get().activateRootBlock(id, "start");
      return;
    }
    set((state) => {
      const newTabs = state.openTabs.includes(id) ? state.openTabs : [...state.openTabs, id];
      return { openTabs: newTabs, closedTabs: state.closedTabs.filter(tab => tab.id !== id) };
    });
  },
  openBlockNextToActive: (id) => {
    set((state) => {
      if (state.openTabs.includes(id)) return state;
      const openTabs = [...state.openTabs];
      const activeIndex = state.activeTab ? openTabs.indexOf(state.activeTab) : -1;
      openTabs.splice(activeIndex >= 0 ? activeIndex + 1 : openTabs.length, 0, id);
      return { openTabs, closedTabs: state.closedTabs.filter(tab => tab.id !== id) };
    });
    get().activateRootBlock(id, "start");
  },
  initSync: () => {
    if (backendApi.mode !== "server") return;
    if (eventSource) return;
    eventSource = new EventSource('/api/events');
    eventSource.onmessage = (e) => {
      if (e.data === ':keepalive') return;
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'update' && msg.block) {
          set(state => {
            // An acknowledgement or external event must not replace newer local input
            // while that block is still waiting to be persisted.
            if (dirtyBlockVersions.has(msg.block.id)) return state;
            const current = state.blocksById[msg.block.id];
            if (current) {
              // Only update if something changed
              if (current.content !== msg.block.content || current.title !== msg.block.title || current.label !== msg.block.label || current.revision !== msg.block.revision) {
                const next = { ...current, ...msg.block, content: current.content !== undefined ? msg.block.content : undefined };
                const blocksById = { ...state.blocksById, [next.id]: next };
                const normalized = normalizeBlocks(state.blockOrder.map(id => blocksById[id]).filter(Boolean));
                return {
                  blocksById,
                  blockIdByLabel: normalized.blockIdByLabel,
                  workspaceIssues: normalized.workspaceIssues,
                  blocksRevision: state.blocksRevision + 1
                };
              }
            } else {
              const next = { ...msg.block, content: undefined };
              const blockOrder = [...state.blockOrder, next.id];
              const blocksById = { ...state.blocksById, [next.id]: next };
              const normalized = normalizeBlocks(blockOrder.map(id => blocksById[id]).filter(Boolean));
              return {
                blockOrder,
                blocksById,
                blockIdByLabel: normalized.blockIdByLabel,
                workspaceIssues: normalized.workspaceIssues,
                blocksRevision: state.blocksRevision + 1
              };
            }
            return state;
          });
        } else if (msg.type === 'reload') {
          void refreshServerBlocks();
        } else if (msg.type === 'delete' && msg.id) {
          if (dirtyBlockVersions.has(msg.id)) {
            set({ persistenceError: 'This note was deleted elsewhere. Your unsaved draft is still in the editor.' });
            return;
          }
          set(state => {
            const idx = state.blockOrder.indexOf(msg.id);
            if (idx === -1) return state;
            const blockOrder = state.blockOrder.filter(id => id !== msg.id);
            const blocksById = { ...state.blocksById };
            const removed = blocksById[msg.id];
            delete blocksById[msg.id];
            const normalized = normalizeBlocks(blockOrder.map(id => blocksById[id]).filter(Boolean));
            const newTabs = state.openTabs.filter(t => t !== msg.id);
            const newActiveTab = state.activeTab === msg.id ? (newTabs.at(-1) || null) : state.activeTab;
            const nextActive = state.activeBlockId === msg.id ? newActiveTab : state.activeBlockId;
            const activeBlock = nextActive ? blocksById[nextActive] : undefined;
            const rootFocusChanged = state.activeBlockId === msg.id;
            return {
              blockOrder,
              blocksById,
              blockIdByLabel: normalized.blockIdByLabel,
              workspaceIssues: normalized.workspaceIssues,
              blocksRevision: state.blocksRevision + 1,
              activeBlockId: nextActive,
              activePath: rootFocusChanged ? (activeBlock ? [activeBlock.label] : null) : state.activePath,
              activeOccurrenceKey: rootFocusChanged ? null : state.activeOccurrenceKey,
              activeFocusPos: rootFocusChanged ? null : state.activeFocusPos,
              activeFocusX: rootFocusChanged ? null : state.activeFocusX,
              focusDirection: rootFocusChanged ? "start" : state.focusDirection,
              openTabs: newTabs,
              activeTab: newActiveTab
            };
          });
        }
      } catch (err) {}
    };
    eventSource.onopen = () => {
      void refreshServerBlocks();
      set(state => state.persistenceError === 'Workspace connection lost. Your latest changes may not be saved.'
        ? { persistenceError: null }
        : state);
    };
    eventSource.onerror = () => {
      set({ persistenceError: 'Workspace connection lost. Your latest changes may not be saved.' });
    };
  }
}));

function scheduleBlockSave(id: string) {
  if (syncTimeouts[id]) clearTimeout(syncTimeouts[id]);
  syncTimeouts[id] = setTimeout(() => {
    delete syncTimeouts[id];
    void flushBlockSave(id);
  }, 500);
}

async function refreshServerBlocks() {
  if (backendApi.mode !== 'server') return;
  const generation = workspaceGeneration;
  try {
    const remote = await backendApi.loadBlocks();
    if (generation !== workspaceGeneration || backendApi.mode !== 'server') return;
    useStore.setState(state => {
      const merged = remote.map(block => {
        const current = state.blocksById[block.id];
        if (!current) return block;
        if (dirtyBlockVersions.has(block.id)) return current;
        return current.revision === block.revision && current.content !== undefined
          ? { ...block, content: current.content }
          : block;
      });
      for (const id of dirtyBlockVersions.keys()) {
        if (!remote.some(block => block.id === id) && state.blocksById[id]) merged.push(state.blocksById[id]);
      }
      return { ...normalizeBlocks(merged), blocksRevision: state.blocksRevision + 1 };
    });
  } catch (error) {
    useStore.setState({ persistenceError: `Could not refresh workspace: ${errorMessage(error)}` });
  }
}

async function flushBlockSave(id: string): Promise<void> {
  if (syncTimeouts[id]) {
    clearTimeout(syncTimeouts[id]);
    delete syncTimeouts[id];
  }

  const existingChain = blockSaveChains.get(id);
  if (existingChain) {
    await existingChain;
    // The active chain normally consumes newer versions in its loop. This
    // second check closes the small hand-off window between its last check and
    // removal from blockSaveChains.
    if (dirtyBlockVersions.has(id)) {
      await new Promise(resolve => setTimeout(resolve, 0));
      return flushBlockSave(id);
    }
    return;
  }

  const chain = (async () => {
    while (dirtyBlockVersions.has(id)) {
      const version = dirtyBlockVersions.get(id)!;
      const state = useStore.getState();
      const block = state.blocksById[id];
      if (!block) {
        dirtyBlockVersions.delete(id);
        return;
      }

      try {
        const result = await backendApi.updateBlock(id, block as BlockData);
        failedBlockSaves.delete(id);
        useStore.setState({ persistenceError: null });

        // An acknowledged write advances the base revision even when the user
        // typed again while the request was in flight. The next save must use
        // this new base without replacing that newer local draft.
        useStore.setState(currentState => {
          const current = currentState.blocksById[id];
          if (!current || !result.block?.revision) return currentState;
          return { blocksById: { ...currentState.blocksById, [id]: { ...current, revision: result.block.revision } } };
        });

        if (dirtyBlockVersions.get(id) === version) {
          dirtyBlockVersions.delete(id);
          const workspace = recoveryWorkspace(useStore.getState());
          if (workspace) {
            try {
              const draft = getLocalRecoveryDraft(workspace, id);
              if (draft && draft.title === block.title && draft.label === block.label && draft.content === block.content) {
                await discardRecoveryDraft(workspace, id, draft.updatedAt);
              }
            } catch (error) { useStore.setState({ persistenceError: `Could not clear saved recovery draft: ${errorMessage(error)}` }); }
          }
        }

        if (result.updatedBlocks?.length) {
          useStore.setState(currentState => {
            const blocksById = { ...currentState.blocksById };
            const blockIdByLabel = cloneLabelIndex(currentState.blockIdByLabel);
            let changed = false;
            for (const updatedBlock of result.updatedBlocks!) {
              // Never let a server response overwrite newer unsaved local input.
              if (dirtyBlockVersions.has(updatedBlock.id)) continue;
              const current = blocksById[updatedBlock.id];
              if (!current) continue;
              if (current.label !== updatedBlock.label && blockIdByLabel[current.label] === current.id) {
                delete blockIdByLabel[current.label];
              }
              blockIdByLabel[updatedBlock.label] = updatedBlock.id;
              blocksById[updatedBlock.id] = {
                ...current,
                label: updatedBlock.label,
                title: updatedBlock.title,
                references: updatedBlock.references,
                revision: updatedBlock.revision,
                ...(current.content !== undefined ? { content: updatedBlock.content } : {})
              };
              changed = true;
            }
            return changed ? {
              blocksById,
              blockIdByLabel,
              blocksRevision: currentState.blocksRevision + 1
            } : currentState;
          });
        }
      } catch (error) {
        console.warn("Failed to save block", error);
        failedBlockSaves.set(id, error);
        useStore.setState({ persistenceError: errorMessage(error) });
        return;
      }
    }
  })();

  blockSaveChains.set(id, chain);
  try {
    await chain;
  } finally {
    if (blockSaveChains.get(id) === chain) blockSaveChains.delete(id);
  }
}

let lastTabs = useStore.getState().openTabs;
let lastActiveTab = useStore.getState().activeTab;
let lastViewOnlyBlocks = useStore.getState().viewOnlyBlocks;
useStore.subscribe((state) => {
    if (state.openTabs === lastTabs && state.activeTab === lastActiveTab && state.viewOnlyBlocks === lastViewOnlyBlocks) return;
    lastTabs = state.openTabs;
    lastActiveTab = state.activeTab;
    lastViewOnlyBlocks = state.viewOnlyBlocks;
    if (!state.isLoaded || (state.backendMode !== 'server' && state.backendMode !== 'local' && state.backendMode !== 'google')) return;
    if (sessionSaveTimer) clearTimeout(sessionSaveTimer);
    sessionSaveTimer = setTimeout(() => {
      void persistWorkspaceSession()
        .catch(error => useStore.setState({ persistenceError: errorMessage(error) }));
    }, 250);
});
