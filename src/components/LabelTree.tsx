import React, { useMemo, useState } from 'react';
import { getOrderedBlocks, useStore } from '../store';
import { ChevronRight, ChevronDown, GitBranch, X } from 'lucide-react';
import { splitPath } from '../lib/utils/path';
import { normalizeBlockLabel, validateBlockLabel } from '../lib/label-policy';
import { SafeRelabelModal } from './SafeRelabelModal';

type TreeNode = {
    name: string;
    blockId?: string;
    children: Record<string, TreeNode>;
};

export function SidebarTree({ 
    onSelect,
    hoveredNodeId,
    onNodeHover
}: { 
    onSelect?: () => void;
    hoveredNodeId?: string | null;
    onNodeHover?: (id: string | null) => void;
}) {
    const blocksRevision = useStore(state => state.blocksRevision);
    const blocks = useMemo(() => getOrderedBlocks(useStore.getState()), [blocksRevision]);
        const openBlockInTab = useStore(state => state.openBlockInTab);
    const activeTab = useStore(state => state.activeTab);
    const backendMode = useStore(state => state.backendMode);
    const [expanded, setExpanded] = useState<Record<string, boolean>>({});
    const [editingPath, setEditingPath] = useState<string | null>(null);
    const [destination, setDestination] = useState('');
    const [editError, setEditError] = useState<string | null>(null);
    const [pendingRelabel, setPendingRelabel] = useState<{ oldPrefix: string, newPrefix: string } | null>(null);

    const tree = useMemo(() => {
        const root: TreeNode = { name: 'root', children: {} };
        blocks.forEach(block => {
            const parts = splitPath(block.label);
            let current = root;
            parts.forEach((part, index) => {
                if (!current.children[part]) {
                    current.children[part] = { name: part, children: {} };
                }
                current = current.children[part];
                if (index === parts.length - 1) {
                    current.blockId = block.id;
                }
            });
        });
        return root;
    }, [blocks]);

    const toggleExpand = (path: string) => {
        setExpanded(prev => ({ ...prev, [path]: !prev[path] }));
    };

    const renderNode = (node: TreeNode, path: string, level: number) => {
        const isFolder = Object.keys(node.children).length > 0;
        const isExpanded = expanded[path] !== false; // Default expanded
        const isActive = activeTab === node.blockId;
        const isHovered = hoveredNodeId === path;
        
        return (
            <div key={path}>
                <div 
                    className={`group/tree-node flex items-center gap-1.5 py-1 px-2 cursor-pointer rounded-md transition-colors ${
                        isActive ? 'bg-accent/20 text-accent font-medium' : 
                        isHovered ? 'bg-accent/15 text-primary' :
                        'text-secondary hover:text-primary hover:bg-accent/10'
                    }`}
                    style={{ paddingLeft: `${level * 12 + 8}px` }}
                    onClick={() => {
                        if (isFolder) {
                            toggleExpand(path);
                        }
                        if (node.blockId) {
                            openBlockInTab(node.blockId, true);
                            if (onSelect) onSelect();
                        }
                    }}
                    onMouseEnter={() => onNodeHover && onNodeHover(path)}
                    onMouseLeave={() => onNodeHover && onNodeHover(null)}
                >
                    {isFolder ? (
                        <div className="opacity-70">
                            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </div>
                    ) : (
                        <div className="w-3.5" /> // spacer
                    )}
                    
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${node.blockId ? 'bg-accent' : 'border border-secondary/70'}`} title={node.blockId ? 'Node with block' : 'Inferred node — no block'} />
                    <span className="min-w-0 flex-1 truncate text-sm select-none">{node.name}</span>
                    {backendMode !== 'viewer' && <button
                        aria-label={`Transform subtree ${path}`}
                        title={node.blockId ? 'Transform this subtree' : 'Transform inferred subtree (no block at this node)'}
                        className="rounded p-1 text-secondary opacity-0 transition-opacity hover:bg-accent/20 hover:text-accent group-hover/tree-node:opacity-100 focus:opacity-100"
                        onClick={(event) => {
                            event.stopPropagation();
                            setEditingPath(path);
                            setDestination(path);
                            setEditError(null);
                        }}
                    ><GitBranch size={13}/></button>}
                </div>
                
                {isFolder && isExpanded && (
                    <div className="flex flex-col">
                        {(Object.values(node.children) as TreeNode[]).map(child => 
                            renderNode(child, `${path}/${child.name}`, level + 1)
                        )}
                    </div>
                )}
            </div>
        );
    };

    const reviewTransformation = () => {
        if (!editingPath) return;
        const normalized = normalizeBlockLabel(destination);
        const validation = validateBlockLabel(normalized);
        if (validation) {
            setEditError(validation);
            return;
        }
        if (normalized === editingPath) {
            setEditError('Choose a different path to transform this node.');
            return;
        }
        setPendingRelabel({ oldPrefix: editingPath, newPrefix: normalized });
        setEditingPath(null);
    };

    return (
        <div className="w-64 border-r border-outline bg-sidebar h-full overflow-y-auto flex flex-col">
            <div className="px-4 py-3 border-b border-outline">
                <h2 className="text-sm font-semibold text-primary">Explorer</h2>
            </div>
            <div className="flex-1 p-2 overflow-y-auto hidden-scrollbar">
                {(Object.values(tree.children) as TreeNode[]).map(child => renderNode(child, child.name, 0))}
            </div>
            {editingPath && <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-labelledby="tree-path-editor-title">
                <div className="w-[min(92vw,520px)] rounded-xl border border-outline bg-surface p-5 shadow-2xl" onClick={event => event.stopPropagation()}>
                    <div className="flex items-start justify-between"><div><div className="text-xs font-semibold uppercase tracking-widest text-accent">Tree transformation</div><h2 id="tree-path-editor-title" className="mt-1 text-lg font-semibold">Choose the new subtree path</h2></div><button aria-label="Close path editor" className="rounded p-1 text-secondary hover:bg-outline" onClick={() => setEditingPath(null)}><X size={18}/></button></div>
                    <div className="mt-4 text-xs text-secondary">Current path</div><div className="mt-1 break-all rounded border border-outline bg-base px-3 py-2 font-mono text-sm">{editingPath}</div>
                    <label className="mt-4 block text-xs text-secondary" htmlFor="tree-destination-path">New path</label>
                    <input id="tree-destination-path" autoFocus value={destination} onChange={event => { setDestination(event.target.value); setEditError(null); }} onKeyDown={event => { if (event.key === 'Enter') reviewTransformation(); if (event.key === 'Escape') setEditingPath(null); }} className="mt-1 w-full rounded border border-outline bg-base px-3 py-2 font-mono text-sm outline-none focus:border-accent" />
                    {!nodeForPath(tree, editingPath)?.blockId && <div className="mt-3 rounded border border-accent/20 bg-accent/5 px-3 py-2 text-xs text-secondary">This is an inferred node with no block. Its descendant block paths will be transformed; no block will be created or deleted.</div>}
                    {editError && <div className="mt-3 text-sm text-red-400">{editError}</div>}
                    <div className="mt-5 flex justify-end gap-2"><button className="rounded border border-outline px-4 py-2 text-sm hover:bg-outline" onClick={() => setEditingPath(null)}>Cancel</button><button className="rounded bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent/80" onClick={reviewTransformation}>Review transformation</button></div>
                </div>
            </div>}
            {pendingRelabel && <SafeRelabelModal oldPrefix={pendingRelabel.oldPrefix} newPrefix={pendingRelabel.newPrefix} onClose={() => setPendingRelabel(null)} />}
        </div>
    );
}

function nodeForPath(root: TreeNode, path: string): TreeNode | undefined {
    let current: TreeNode | undefined = root;
    for (const part of splitPath(path)) current = current?.children[part];
    return current;
}
