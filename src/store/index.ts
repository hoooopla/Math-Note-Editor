import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';

export interface BlockData {
  id: string;
  title: string;
  label: string;
  content: string;
  _fileMeta?: any;
}

interface AppState {
  blocks: BlockData[];
  activeBlockId: string | null;
  activePath: string[] | null;
  activeFocusPos: number | null;
  focusDirection: "start" | "end" | null;
  macros: Record<string, string>;
  loadBlocks: () => Promise<void>;
  addBlock: (index?: number, data?: Partial<BlockData>) => Promise<BlockData | void>;
  updateBlock: (id: string, data: Partial<BlockData>) => void;
  deleteBlock: (id: string) => Promise<void>;
  setActiveBlock: (id: string | null, dir?: "start" | "end" | null, path?: string[] | null, pos?: number | null) => void;
  setMacros: (macros: Record<string, string>) => void;
}

const syncTimeouts: Record<string, NodeJS.Timeout> = {};

export const useStore = create<AppState>((set, get) => ({
  blocks: [],
  activeBlockId: null,
  activePath: null,
  activeFocusPos: null,
  focusDirection: null,
  macros: {
    "\\R": "\\mathbb{R}",
    "\\N": "\\mathbb{N}"
  },
  loadBlocks: async () => {
    try {
      const res = await fetch('/api/blocks');
      const blocks = await res.json();
      set({ blocks });
    } catch (e) {
      console.error("Failed to load blocks", e);
    }
  },
  addBlock: async (index, data) => {
    const newBlockData = { title: 'New Block', label: 'block', content: '', ...data };
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
    // Optimistic update
    set((state) => ({
      blocks: state.blocks.map(b => b.id === id ? { ...b, ...data } : b)
    }));
    
    // Background sync
    if (syncTimeouts[id]) {
      clearTimeout(syncTimeouts[id]);
    }

    syncTimeouts[id] = setTimeout(() => {
      const block = get().blocks.find(b => b.id === id);
      if (!block) return;

      fetch(`/api/blocks/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(block)
      }).catch(console.error);
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
}));
