import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import { api as backendApi, EditorSettings } from './api';

export interface BlockData {
  id: string;
  title: string;
  label: string;
  content?: string;
  hasContent?: boolean;
  _fileMeta?: any;
}

interface AppState {
  blocks: BlockData[];
  activeBlockId: string | null;
  activePath: string[] | null;
  activeFocusPos: number | null;
  focusDirection: "start" | "end" | null;
  settings: EditorSettings;
  openTabs: string[];
  activeTab: string | null;
  backendMode: "server" | "local" | "none";
  initBackend: () => Promise<void>;
  connectLocalFS: () => Promise<void>;
  loadBlocks: () => Promise<void>;
  loadSettings: () => Promise<void>;
  saveSettings: (settings: EditorSettings) => Promise<void>;
  loadBlockContent: (id: string) => Promise<void>;
  addBlock: (index?: number, data?: Partial<BlockData>) => Promise<BlockData | void>;
  updateBlock: (id: string, data: Partial<BlockData>) => void;
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
  imageUploadParams: { file: File, onInsert: (text: string) => void } | null;
  setImageUploadParams: (params: { file: File, onInsert: (text: string) => void } | null) => void;
}

const syncTimeouts: Record<string, NodeJS.Timeout> = {};

let eventSource: EventSource | null = null;

export const useStore = create<AppState>((set, get) => ({
  blocks: [],
  activeBlockId: null,
  activePath: null,
  activeFocusPos: null,
  focusDirection: null,
  openTabs: [],
  activeTab: null,
  backendMode: "none",
  imageUploadParams: null,
  setImageUploadParams: (params) => set({ imageUploadParams: params }),
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
  },
  connectLocalFS: async () => {
    const success = await backendApi.connectLocalFS();
    if (success) {
      set({ backendMode: backendApi.mode });
      await get().loadBlocks();
      await get().loadSettings();
    }
  },
  loadSettings: async () => {
    try {
      const data = await backendApi.loadSettings();
      if (data) {
        set({ settings: data });
      }
    } catch (e) {
      console.error("Failed to load settings", e);
    }
  },
  saveSettings: async (settings) => {
    try {
      set({ settings });
      await backendApi.saveSettings(settings);
    } catch (e) {
      console.error("Failed to save settings", e);
    }
  },
  loadBlocks: async () => {
    try {
      const blocks = await backendApi.loadBlocks();
      set({ blocks });
    } catch (e) {
      console.error("Failed to load blocks", e);
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
      console.error("Failed to load block content", e);
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
          return { blocks: newBlocks, activeBlockId: newBlock.id, focusDirection: "start" };
        }
        return { blocks: [...withoutNew, newBlock], activeBlockId: newBlock.id, focusDirection: "start" };
      });
      return newBlock;
    } catch (e) {
      console.error("Failed to add block", e);
    }
  },
  updateBlock: (id, data) => {
    set((state) => ({
      blocks: state.blocks.map(b => b.id === id ? { ...b, ...data } : b)
    }));

    if (syncTimeouts[id]) {
      clearTimeout(syncTimeouts[id]);
    }

    syncTimeouts[id] = setTimeout(async () => {
      const block = get().blocks.find(b => b.id === id);
      if (!block) return;

      try {
        const result = await backendApi.updateBlock(id, block as BlockData, get().blocks);
        if (result.updatedBlocks && result.updatedBlocks.length > 0) {
            // Apply server-side cascades (label renames & reference updates)
            set(s => {
                const newBlocks = [...s.blocks];
                result.updatedBlocks!.forEach((ub: any) => {
                    const idx = newBlocks.findIndex(b => b.id === ub.id);
                    if (idx !== -1) {
                        // Only update content if we already have it loaded, 
                        // or if the server gave us updated content.
                        const current = newBlocks[idx];
                        newBlocks[idx] = { 
                            ...current, 
                            label: ub.label,
                            title: ub.title,
                            ...(current.content !== undefined ? { content: ub.content } : {})
                        };
                    }
                });
                return { blocks: newBlocks };
            });
        }
      } catch (e) {
          console.error(e);
      }
    }, 500);
  },
  deleteBlock: async (id) => {
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
        return { blocks: newBlocks, activeBlockId: nextActive, focusDirection: "end" };
      });
    } catch (e) {
      console.error("Failed to delete block", e);
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
