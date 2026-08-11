import React, { useMemo, useState } from 'react';
import { useStore } from '../store';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { splitPath } from '../lib/utils/path';

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
    const blocks = useStore(state => state.blocks);
        const openBlockInTab = useStore(state => state.openBlockInTab);
    const activeTab = useStore(state => state.activeTab);
    const [expanded, setExpanded] = useState<Record<string, boolean>>({});

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
                    className={`flex items-center gap-1.5 py-1 px-2 cursor-pointer rounded-md transition-colors ${
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
                    
                    <span className="text-sm truncate select-none">{node.name}</span>
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

    return (
        <div className="w-64 border-r border-outline bg-sidebar h-full overflow-y-auto flex flex-col">
            <div className="px-4 py-3 border-b border-outline">
                <h2 className="text-sm font-semibold text-primary">Explorer</h2>
            </div>
            <div className="flex-1 p-2 overflow-y-auto hidden-scrollbar">
                {(Object.values(tree.children) as TreeNode[]).map(child => renderNode(child, child.name, 0))}
            </div>
        </div>
    );
}
