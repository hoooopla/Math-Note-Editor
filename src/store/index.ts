import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import { api as backendApi, EditorSettings, parseFrontmatter, computeReferences } from './api';

export interface BlockData {
  id: string;
  title: string;
  label: string;
  content?: string;
  hasContent?: boolean;
  references?: string[];
  _fileMeta?: any;
}

interface AppState {
  isLoaded: boolean;
  isLoadingFiles?: boolean;
  blocks: BlockData[];
  activeBlockId: string | null;
  activePath: string[] | null;
  activeFocusPos: number | null;
  focusDirection: "start" | "end" | null;
  settings: EditorSettings;
  openTabs: string[];
  activeTab: string | null;
  backendMode: "server" | "local" | "viewer" | "none";
  loadViewerFiles: (files: FileList) => Promise<void>;
  initBackend: () => Promise<void>;
  connectLocalFS: () => Promise<void>;
  loadBlocks: () => Promise<void>;
  loadSettings: () => Promise<void>;
  saveSettings: (settings: EditorSettings) => Promise<void>;
  loadBlockContent: (id: string) => Promise<void>;
  addBlock: (index?: number, data?: Partial<BlockData>) => Promise<BlockData | void>;
  updateBlock: (id: string, data: Partial<BlockData>) => void;
  flushBlock: (id: string) => Promise<void>;
  flushPendingSaves: () => Promise<void>;
  deleteBlock: (id: string) => Promise<void>;
  setActiveBlock: (id: string | null, dir?: "start" | "end" | null, path?: string[] | null, pos?: number | null) => void;
  setSettings: (settings: EditorSettings) => void;
  setOpenTabs: (tabs: string[]) => void;
  setActiveTab: (id: string | null) => void;
  openBlockInTab: (id: string, activate: boolean) => void;
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

let eventSource: EventSource | null = null;

const savedTabsStr = localStorage.getItem("openTabs");
let savedTabs: string[] = [];
if (savedTabsStr) {
  try {
    const parsed = JSON.parse(savedTabsStr);
    if (Array.isArray(parsed) && parsed.every(value => typeof value === 'string')) {
      savedTabs = parsed;
    } else {
      localStorage.removeItem("openTabs");
    }
  } catch {
    localStorage.removeItem("openTabs");
  }
}
const savedActiveTab = localStorage.getItem("activeTab");

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

export const useStore = create<AppState>((set, get) => ({
  isLoaded: false,
  isLoadingFiles: false,
  blocks: [],
  activeBlockId: null,
  activePath: null,
  activeFocusPos: null,
  focusDirection: null,
  openTabs: savedTabs,
  activeTab: savedActiveTab,
  backendMode: "none",
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
    const newBlocks: BlockData[] = [];
    let loadedSettings: any = null;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.name.endsWith('.md')) {
        const text = await file.text();
        const { data, content } = parseFrontmatter(text);
        const id = data.id || file.name.replace('.md', '');
        newBlocks.push({
          id,
          title: data.title || '',
          label: data.label || '',
          references: data.references || computeReferences(content),
          content,
          hasContent: content.trim().length > 0
        });
      } else if (file.name === 'settings.json' && file.webkitRelativePath.includes('/setting/')) {
        try {
          loadedSettings = JSON.parse(await file.text());
        } catch (e) {}
      }
    }
    
    backendApi.mode = 'viewer';
    set({ blocks: newBlocks, backendMode: 'viewer', isLoaded: true, persistenceError: null });
    
    if (loadedSettings) {
      set(state => ({ settings: { ...state.settings, ...loadedSettings } }));
    }
    
    // Auto-open first tab if any
    if (newBlocks.length > 0) {
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
  loadSettings: async () => {
    try {
      const data = await backendApi.loadSettings();
      if (data) {
        set({ settings: data });
      }
    } catch (e) {
      console.warn("Failed to load settings", e);
    }
  },
  saveSettings: async (settings) => {
    const previousSettings = get().settings;
    try {
      set({ settings, persistenceError: null });
      await backendApi.saveSettings(settings);
    } catch (e) {
      console.warn("Failed to save settings", e);
      set({ settings: previousSettings, persistenceError: errorMessage(e) });
    }
  },
  loadBlocks: async () => {
    try {
      const blocks = await backendApi.loadBlocks();
      set({ blocks, persistenceError: null });
    } catch (e) {
      console.warn("Failed to load blocks", e);
      set({ persistenceError: errorMessage(e) });
    }
  },
  loadBlockContent: async (id: string) => {
    try {
      const block = get().blocks.find(b => b.id === id);
      if (block && block.content !== undefined) return; // already loaded
      
      const fullBlock = await backendApi.loadBlockContent(id, get().blocks);
      if (!fullBlock) return;
      set(state => ({
        blocks: state.blocks.map(b => b.id === id ? { ...b, content: fullBlock.content } : b)
      }));
    } catch (e) {
      console.warn("Failed to load block content", e);
    }
  },
  addBlock: async (index, data) => {
    let baseLabel = data?.label || 'block';
    let label = baseLabel;
    
    const { blocks } = get();
    if (blocks.some(b => b.label === label)) {
        let counter = 1;
        while (blocks.some(b => b.label === `${baseLabel}-${counter}`)) {
            counter++;
        }
        label = `${baseLabel}-${counter}`;
    }

    const newBlockData = { title: 'New Block', label, content: '', ...data };
    try {
      const newBlock = await backendApi.addBlock(newBlockData, get().blocks);
      
      set((state) => {
        const withoutNew = state.blocks.filter(b => b.id !== newBlock.id);
        if (index !== undefined && index !== -1) {
          const newBlocks = [...withoutNew];
          const insertIdx = index >= withoutNew.length ? withoutNew.length : index + 1;
          newBlocks.splice(insertIdx, 0, newBlock);
          return { blocks: newBlocks, activeBlockId: newBlock.id, focusDirection: "start", persistenceError: null };
        }
        return { blocks: [...withoutNew, newBlock], activeBlockId: newBlock.id, focusDirection: "start", persistenceError: null };
      });
      return newBlock;
    } catch (e) {
      console.warn("Failed to add block", e);
      set({ persistenceError: errorMessage(e) });
    }
  },
  updateBlock: (id, data) => {
    set((state) => ({
      blocks: state.blocks.map(b => b.id === id ? { ...b, ...data } : b)
    }));

    dirtyBlockVersions.set(id, (dirtyBlockVersions.get(id) || 0) + 1);
    scheduleBlockSave(id);
  },
  flushBlock: async (id) => {
    await flushBlockSave(id);
  },
  flushPendingSaves: async () => {
    await Promise.all(Array.from(dirtyBlockVersions.keys(), id => flushBlockSave(id)));
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
      await backendApi.deleteBlock(id, get().blocks);
      set((state) => {
        const idx = state.blocks.findIndex(b => b.id === id);
        if (idx === -1) return state;
        const newBlocks = state.blocks.filter(b => b.id !== id);
        let nextActive = state.activeBlockId;
        if (state.activeBlockId === id) {
            if (newBlocks.length > 0) {
                nextActive = newBlocks[Math.max(0, idx - 1)].id;
            } else {
                nextActive = null;
            }
        }
        return { blocks: newBlocks, activeBlockId: nextActive, focusDirection: "end", persistenceError: null };
      });
    } catch (e) {
      console.warn("Failed to delete block", e);
      set({ persistenceError: errorMessage(e) });
    }
  },
  setActiveBlock: (id, dir, path, pos) => set({ activeBlockId: id, focusDirection: dir || null, activePath: path || null, activeFocusPos: pos ?? null }),
  setSettings: (settings) => set({ settings }),
  setOpenTabs: (tabs) => set({ openTabs: tabs }),
  setActiveTab: (id) => set({ activeTab: id }),
  openBlockInTab: (id, activate) => {
    set((state) => {
      const newTabs = state.openTabs.includes(id) ? state.openTabs : [...state.openTabs, id];
      return { 
        openTabs: newTabs, 
        activeTab: activate ? id : state.activeTab 
      };
    });
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
            const idx = state.blocks.findIndex(b => b.id === msg.block.id);
            if (idx !== -1) {
              const current = state.blocks[idx];
              // Only update if something changed
              if (current.content !== msg.block.content || current.title !== msg.block.title || current.label !== msg.block.label) {
                const newBlocks = [...state.blocks];
                newBlocks[idx] = { ...current, ...msg.block, content: current.content !== undefined ? msg.block.content : undefined };
                // Also update content if it was loaded
                return { blocks: newBlocks };
              }
            } else {
              return { blocks: [...state.blocks, { ...msg.block, content: undefined }] };
            }
            return state;
          });
        } else if (msg.type === 'delete' && msg.id) {
          set(state => {
            const idx = state.blocks.findIndex(b => b.id === msg.id);
            if (idx === -1) return state;
            const newBlocks = state.blocks.filter(b => b.id !== msg.id);
            let nextActive = state.activeBlockId;
            let newTabs = state.openTabs.filter(t => t !== msg.id);
            let newActiveTab = state.activeTab === msg.id ? (newTabs.length > 0 ? newTabs[newTabs.length - 1] : null) : state.activeTab;
            
            if (state.activeBlockId === msg.id) {
                if (newBlocks.length > 0) {
                    nextActive = newBlocks[Math.max(0, idx - 1)].id;
                } else {
                    nextActive = null;
                }
            }
            return { blocks: newBlocks, activeBlockId: nextActive, openTabs: newTabs, activeTab: newActiveTab };
          });
        }
      } catch (err) {}
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
  if (existingChain) return existingChain;

  const chain = (async () => {
    while (dirtyBlockVersions.has(id)) {
      const version = dirtyBlockVersions.get(id)!;
      const state = useStore.getState();
      const block = state.blocks.find(candidate => candidate.id === id);
      if (!block) {
        dirtyBlockVersions.delete(id);
        return;
      }

      try {
        const result = await backendApi.updateBlock(id, block as BlockData, state.blocks);
        useStore.setState({ persistenceError: null });

        if (dirtyBlockVersions.get(id) === version) {
          dirtyBlockVersions.delete(id);
        }

        if (result.updatedBlocks?.length) {
          useStore.setState(currentState => {
            const nextBlocks = [...currentState.blocks];
            for (const updatedBlock of result.updatedBlocks!) {
              // Never let a server response overwrite newer unsaved local input.
              if (dirtyBlockVersions.has(updatedBlock.id)) continue;
              const index = nextBlocks.findIndex(candidate => candidate.id === updatedBlock.id);
              if (index === -1) continue;
              const current = nextBlocks[index];
              nextBlocks[index] = {
                ...current,
                label: updatedBlock.label,
                title: updatedBlock.title,
                ...(current.content !== undefined ? { content: updatedBlock.content } : {})
              };
            }
            return { blocks: nextBlocks };
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

let lastTabs = savedTabs;
let lastActiveTab = savedActiveTab;
useStore.subscribe((state) => {
    if (state.openTabs !== lastTabs) {
        localStorage.setItem("openTabs", JSON.stringify(state.openTabs));
        lastTabs = state.openTabs;
    }
    if (state.activeTab !== lastActiveTab) {
        if (state.activeTab) {
            localStorage.setItem("activeTab", state.activeTab);
        } else {
            localStorage.removeItem("activeTab");
        }
        lastActiveTab = state.activeTab;
    }
});
