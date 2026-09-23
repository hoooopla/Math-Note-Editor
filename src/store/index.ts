import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import { api as backendApi, EditorSettings, WorkspaceBackup, parseFrontmatter, computeReferences } from './api';
import { metadataText } from '../lib/block-metadata';
import { normalizeBlockLabel, normalizeBlockTitle, validateBlockLabel, validateBlockMetadata, validateBlockTitle } from '../lib/label-policy';
import { SafeRelabelPlan } from '../lib/safe-relabel';
import { DuplicateLabelIssue, findDuplicateLabelIssues } from '../lib/workspace-validation';

export interface BlockData {
  id: string;
  title: string;
  label: string;
  content?: string;
  hasContent?: boolean;
  references?: string[];
  _fileMeta?: any;
}

interface TabFocusState {
  activeBlockId: string | null;
  activePath: string[] | null;
  activeFocusPos: number | null;
  activeFocusX: number | null;
  focusDirection: "start" | "end" | null;
}

interface ClosedTab {
  id: string;
  index: number;
  focusState?: TabFocusState;
}

export interface AppState {
  isLoaded: boolean;
  isLoadingFiles?: boolean;
  blockOrder: string[];
  blocksById: Record<string, BlockData>;
  blockIdByLabel: Record<string, string>;
  workspaceIssues: DuplicateLabelIssue[];
  blocksRevision: number;
  activeBlockId: string | null;
  activePath: string[] | null;
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
  loadViewerFiles: (files: FileList) => Promise<void>;
  initBackend: () => Promise<void>;
  connectLocalFS: () => Promise<void>;
  connectGoogleDrive: () => Promise<void>;
  disconnectGoogleDrive: () => Promise<void>;
  loadBlocks: () => Promise<void>;
  loadSettings: () => Promise<void>;
  saveSettings: (settings: EditorSettings) => Promise<void>;
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
  setActiveBlock: (id: string | null, dir?: "start" | "end" | null, path?: string[] | null, pos?: number | null, x?: number | null) => void;
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
  saveAsset: (file: File, filename: string) => Promise<string>;
  listAssets: () => Promise<string[]>;
  getAssetUrl: (path: string) => Promise<string>;
  viewOnlyBlocks: Record<string, boolean>;
  toggleViewOnly: (id: string) => void;
  imageUploadParams: { file: File, onInsert: (text: string) => void } | null;
  setImageUploadParams: (params: { file: File, onInsert: (text: string) => void } | null) => void;
  persistenceError: string | null;
  clearPersistenceError: () => void;
}

const syncTimeouts: Record<string, ReturnType<typeof setTimeout>> = {};
const dirtyBlockVersions = new Map<string, number>();
const blockSaveChains = new Map<string, Promise<void>>();
const pendingBlockLabels = new Set<string>();

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
  sessionSavePromise = sessionSavePromise.then(() => {
    const current = useStore.getState();
    const workspaceSession = { openTabs: current.openTabs, activeTab: current.activeTab };
    return backendApi.saveWorkspaceSession(workspaceSession);
  });
  return sessionSavePromise;
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

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
  activeBlockId: null,
  activePath: null,
  activeFocusPos: null,
  activeFocusX: null,
  focusDirection: null,
  openTabs: [],
  activeTab: null,
  tabFocusStates: {},
  closedTabs: [],
  backendMode: "none",
  googleFolderName: null,
  viewOnlyBlocks: {},
  toggleViewOnly: (id) => set(state => {
    const current = state.viewOnlyBlocks[id] ?? (state.backendMode === "viewer");
    return { viewOnlyBlocks: { ...state.viewOnlyBlocks, [id]: !current } };
  }),
  imageUploadParams: null,
  setImageUploadParams: (params) => set({ imageUploadParams: params }),
  persistenceError: null,
  clearPersistenceError: () => set({ persistenceError: null }),
  settings: {
    macros: {
      "\\R": "\\mathbb{R}",
      "\\N": "\\mathbb{N}"
    },
    customCommands: [],
    textCommands: [],
    searchShortcut: "meta+k",
    editMetadataShortcut: "f2",
    goToParentShortcut: "mod+shift+arrowup",
    closeTabShortcut: "mod+w",
    reopenClosedTabShortcut: "mod+shift+t",
    nextTabShortcut: "ctrl+tab",
    previousTabShortcut: "ctrl+shift+tab",
    inlineBlockTitleColorWithContent: "#a8b5c2", // or whatever secondary is
    inlineBlockTitleColorEmpty: "#FF997D",
    inlineBlockTitleUnderlineOpacity: 100,
    inlineBlockIndentWidth: 16,
    standoutBlockTitleColorWithContent: "#a8b5c2",
    standoutBlockTitleColorEmpty: "#FF997D",
    standoutBlockIndentWidth: 0,
    standoutBlockTitlePaddingLeft: 10,
    standoutBlockTitlePaddingRight: 6,
    standoutBlockTitlePaddingTop: 5,
    standoutBlockTitlePaddingBottom: 5,
    standoutBlockContentPaddingLeft: 10,
    standoutBlockContentPaddingTop: 8,
    standoutBlockContentPaddingRight: 12,
    standoutBlockContentPaddingBottom: 12,
    standoutBlockBorderColor: "#ffffff",
    standoutBlockDividerColor: "#ffffff",
    standoutBlockBorderWidth: 1,
    standoutBlockDividerWidth: 1,
    mathHighlightColor: "#d19a66",
    mathColors: {
      command: "#61afef",
      brace: "#e5c07b",
      script: "#c678dd",
      comment: "#8b949e",
      delimiter: "#98c379",
      align: "#e06c75",
      escaped: "#56b6c2"
    }
  },
  saveAsset: async (file: File, filename: string) => {
    return await backendApi.saveAsset(file, filename);
  },
  listAssets: async () => {
    return await backendApi.listAssets();
  },
  getAssetUrl: async (path: string) => {
    return await backendApi.getAssetUrl(path);
  },
  initBackend: async () => {
    await backendApi.init();
    set({ backendMode: backendApi.mode });
    if (backendApi.mode !== "none") {
      await get().loadBlocks();
      await get().loadSettings();
      get().initSync();
    }
    set({ isLoaded: true });
  },

  loadViewerFiles: async (files: FileList) => {
    set({ isLoadingFiles: true });
    backendApi.setViewerFiles(files);
    const newBlocks: BlockData[] = [];
    let loadedSettings: any = null;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
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
    
    backendApi.mode = 'viewer';
    set(state => ({
      ...normalizeBlocks(newBlocks),
      blocksRevision: state.blocksRevision + 1,
      backendMode: 'viewer',
      isLoaded: true,
      persistenceError: null
    }));
    
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
    set({ isLoadingFiles: false });
  },

  connectLocalFS: async () => {
    set({ isLoadingFiles: true });
    try {
      const success = await backendApi.connectLocalFS();
      if (success) {
        set({ backendMode: backendApi.mode });
        await get().loadBlocks();
        await get().loadSettings();
        set({ isLoaded: true });
      }
    } finally {
      set({ isLoadingFiles: false });
    }
  },
  connectGoogleDrive: async () => {
    set({ isLoadingFiles: true, persistenceError: null });
    try {
      await get().flushPendingSaves();
      const selected = await backendApi.connectGoogleDrive();
      set({ backendMode: 'google', googleFolderName: selected.name });
      await get().loadBlocks();
      await get().loadSettings();
      const first = get().blockOrder[0];
      if (first && get().openTabs.length === 0) set({ openTabs: [first], activeTab: first });
      set({ isLoaded: true });
    } catch (error) {
      set({ persistenceError: errorMessage(error) });
    } finally {
      set({ isLoadingFiles: false });
    }
  },
  disconnectGoogleDrive: async () => {
    try {
      await get().flushPendingSaves();
      await backendApi.disconnectGoogleDrive();
      set(state => ({
        ...normalizeBlocks([]),
        blocksRevision: state.blocksRevision + 1,
        backendMode: 'none',
        googleFolderName: null,
        openTabs: [],
        activeTab: null,
        persistenceError: null
      }));
    } catch (error) {
      set({ persistenceError: errorMessage(error) });
    }
  },
  loadSettings: async () => {
    try {
      const data = await backendApi.loadSettings();
      if (data) {
        const validIds = new Set(get().blockOrder);
        const openTabs = (data.workspaceSession?.openTabs || []).filter((id: unknown): id is string => typeof id === 'string' && validIds.has(id));
        const activeTab = openTabs.includes(data.workspaceSession?.activeTab || '') ? data.workspaceSession!.activeTab : openTabs[0] || null;
        set({ settings: data, openTabs, activeTab });
      }
    } catch (e) {
      console.warn("Failed to load settings", e);
    }
  },
  saveSettings: async (settings) => {
    const previousSettings = get().settings;
    const settingsWithSession = {
      ...settings,
      workspaceSession: { openTabs: get().openTabs, activeTab: get().activeTab }
    };
    try {
      set({ settings: settingsWithSession, persistenceError: null });
      await backendApi.saveSettings(settingsWithSession);
    } catch (e) {
      console.warn("Failed to save settings", e);
      set({ settings: previousSettings, persistenceError: errorMessage(e) });
    }
  },
  listBackups: () => backendApi.listBackups(),
  restoreBackup: async (path) => {
    await get().flushPendingSaves();
    await backendApi.restoreBackup(path);
    await get().loadBlocks();
    if (path === 'setting/settings.json') await get().loadSettings();
  },
  loadBlocks: async () => {
    try {
      const blocks = await backendApi.loadBlocks();
      set(state => ({
        ...normalizeBlocks(blocks),
        blocksRevision: state.blocksRevision + 1,
        persistenceError: null
      }));
    } catch (e) {
      console.warn("Failed to load blocks", e);
      set({ persistenceError: errorMessage(e) });
    }
  },
  loadBlockContent: async (id: string) => {
    try {
      const block = get().blocksById[id];
      if (block && block.content !== undefined) return; // already loaded
      
      const fullBlock = await backendApi.loadBlockContent(id);
      if (!fullBlock) return;
      set(state => {
        const current = state.blocksById[id];
        if (!current || current.content !== undefined) return state;
        return {
          blocksById: {
            ...state.blocksById,
            [id]: { ...current, content: fullBlock.content }
          }
        };
      });
    } catch (e) {
      console.warn("Failed to load block content", e);
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
    const result = await backendApi.commitRelabel(plan);
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
  },
  repairDuplicateLabel: async (id, newLabel) => {
    try {
      await get().flushBlock(id);
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
      return true;
    } catch (e) {
      set({ persistenceError: errorMessage(e) });
      return false;
    }
  },
  deleteBlock: async (id) => {
    if (syncTimeouts[id]) {
      clearTimeout(syncTimeouts[id]);
      delete syncTimeouts[id];
    }
    const activeSave = blockSaveChains.get(id);
    if (activeSave) await activeSave;
    dirtyBlockVersions.delete(id);
    try {
      await backendApi.deleteBlock(id);
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
          activeFocusPos: rootFocusChanged ? null : state.activeFocusPos,
          activeFocusX: rootFocusChanged ? null : state.activeFocusX,
          focusDirection: rootFocusChanged ? "start" : state.focusDirection,
          persistenceError: null
        };
      });
    } catch (e) {
      console.warn("Failed to delete block", e);
      set({ persistenceError: errorMessage(e) });
    }
  },
  setActiveBlock: (id, dir, path, pos, x) => set(state => {
    const focusState = {
      activeBlockId: id,
      focusDirection: dir || null,
      activePath: path || null,
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
        activeFocusPos: null,
        activeFocusX: null,
        focusDirection: null
      };
      const block = state.blocksById[fallback];
      const restored = tabFocusStates[fallback] || {
        activeBlockId: fallback,
        activePath: block ? [block.label] : null,
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
              if (current.content !== msg.block.content || current.title !== msg.block.title || current.label !== msg.block.label || current.references !== msg.block.references) {
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
        } else if (msg.type === 'delete' && msg.id) {
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
        useStore.setState({ persistenceError: null });

        if (dirtyBlockVersions.get(id) === version) {
          dirtyBlockVersions.delete(id);
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
useStore.subscribe((state) => {
    if (state.openTabs === lastTabs && state.activeTab === lastActiveTab) return;
    lastTabs = state.openTabs;
    lastActiveTab = state.activeTab;
    if (!state.isLoaded || (state.backendMode !== 'server' && state.backendMode !== 'local' && state.backendMode !== 'google')) return;
    if (sessionSaveTimer) clearTimeout(sessionSaveTimer);
    sessionSaveTimer = setTimeout(() => {
      void persistWorkspaceSession()
        .catch(error => useStore.setState({ persistenceError: errorMessage(error) }));
    }, 250);
});
