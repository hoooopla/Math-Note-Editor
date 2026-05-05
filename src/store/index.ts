import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';

export interface BlockData {
  id: string;
  title: string;
  label: string;
  content?: string;
  _fileMeta?: any;
}

interface AppState {
  blocks: BlockData[];
  activeBlockId: string | null;
  activePath: string[] | null;
  activeFocusPos: number | null;
  focusDirection: "start" | "end" | null;
  macros: Record<string, string>;
  openTabs: string[];
  activeTab: string | null;
  loadBlocks: () => Promise<void>;
  loadMacros: () => Promise<void>;
  saveMacros: (macros: Record<string, string>) => Promise<void>;
  loadBlockContent: (id: string) => Promise<void>;
  addBlock: (index?: number, data?: Partial<BlockData>) => Promise<BlockData | void>;
  updateBlock: (id: string, data: Partial<BlockData>) => void;
  deleteBlock: (id: string) => Promise<void>;
  setActiveBlock: (id: string | null, dir?: "start" | "end" | null, path?: string[] | null, pos?: number | null) => void;
  setMacros: (macros: Record<string, string>) => void;
  setOpenTabs: (tabs: string[]) => void;
  setActiveTab: (id: string | null) => void;
  openBlockInTab: (id: string, activate: boolean) => void;
}

const syncTimeouts: Record<string, NodeJS.Timeout> = {};

export const useStore = create<AppState>((set, get) => ({
  blocks: [],
  activeBlockId: null,
  activePath: null,
  activeFocusPos: null,
  focusDirection: null,
  openTabs: [],
  activeTab: null,
  macros: {
    "\\R": "\\mathbb{R}",
    "\\N": "\\mathbb{N}"
  },
  loadMacros: async () => {
    try {
      const res = await fetch('/api/macros');
      const data = await res.json();
      if (Object.keys(data).length > 0) {
        set({ macros: data });
      }
    } catch (e) {
      console.error("Failed to load macros", e);
    }
  },
  saveMacros: async (macros) => {
    try {
      set({ macros });
      await fetch('/api/macros', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(macros),
      });
    } catch (e) {
      console.error("Failed to save macros", e);
    }
  },
  loadBlocks: async () => {
    try {
      const res = await fetch('/api/blocks?metaOnly=true');
      const blocks = await res.json();
      set({ blocks });
    } catch (e) {
      console.error("Failed to load blocks", e);
    }
  },
  loadBlockContent: async (id: string) => {
    try {
      const block = get().blocks.find(b => b.id === id);
      if (block && block.content !== undefined) return; // already loaded
      
      const res = await fetch(`/api/blocks/${id}`);
      if (!res.ok) return;
      const fullBlock = await res.json();
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
      const res = await fetch('/api/blocks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newBlockData)
      });
      const newBlock = await res.json();
      
      set((state) => {
        if (index !== undefined && index !== -1) {
          const newBlocks = [...state.blocks];
          newBlocks.splice(index + 1, 0, newBlock);
          return { blocks: newBlocks, activeBlockId: newBlock.id, focusDirection: "start" };
        }
        return { blocks: [...state.blocks, newBlock], activeBlockId: newBlock.id, focusDirection: "start" };
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
        const res = await fetch(`/api/blocks/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(block)
        });
        if (res.ok) {
            const result = await res.json();
            if (result.updatedBlocks && result.updatedBlocks.length > 0) {
                // Apply server-side cascades (label renames & reference updates)
                set(s => {
                    const newBlocks = [...s.blocks];
                    result.updatedBlocks.forEach((ub: any) => {
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
        }
      } catch (e) {
          console.error(e);
      }
    }, 500);
  },
  deleteBlock: async (id) => {
    try {
      await fetch(`/api/blocks/${id}`, { method: 'DELETE' });
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
  setMacros: (macros) => set({ macros }),
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
}));
