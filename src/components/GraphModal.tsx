import React, { useMemo, useRef, useEffect } from 'react';
import { useStore } from '../store';
import { X } from 'lucide-react';
import ForceGraph2D from 'react-force-graph-2d';
import { SidebarTree } from './SidebarTree';
import { splitPath } from '../lib/utils/path';

export function GraphModal({ isOpen, onClose }: { isOpen: boolean, onClose: () => void }) {
    const { blocks, openBlockInTab } = useStore();
    const containerRef = useRef<HTMLDivElement>(null);
    const [dimensions, setDimensions] = React.useState({ width: 800, height: 600 });

    useEffect(() => {
        if (isOpen && containerRef.current) {
            setDimensions({
                width: containerRef.current.clientWidth,
                height: containerRef.current.clientHeight
            });
        }
    }, [isOpen]);

    const graphData = useMemo(() => {
        const topLevelGroups = Array.from(new Set(blocks.map(b => splitPath(b.label)[0])));
        
        const getGroupColor = (group: string, depth: number) => {
            const groupIndex = topLevelGroups.indexOf(group);
            const hue = (groupIndex * 137.5) % 360;
            const lightness = Math.min(85, 50 + depth * 8);
            return `hsl(${hue}, 75%, ${lightness}%)`;
        };

        const nodes = blocks.map(b => {
            const parts = splitPath(b.label);
            const group = parts[0] || 'default';
            const depth = parts.length - 1;

            return {
                id: b.label, // use label as id for easy reference mapping
                name: b.title || b.label,
                val: Math.max(0.5, 2 - depth * 0.3), // Make root nodes slightly larger
                color: getGroupColor(group, depth),
                blockId: b.id
            };
        });

        const links: any[] = [];
        blocks.forEach(b => {
            if (b.references && b.references.length > 0) {
                b.references.forEach(rawRefLabel => {
                    let refLabel = rawRefLabel.trim();
                    if (refLabel.startsWith('/')) {
                        refLabel = b.label + refLabel;
                    }
                    // Check if reference exists
                    if (nodes.some(n => n.id === refLabel)) {
                        links.push({
                            source: b.label,
                            target: refLabel
                        });
                    }
                });
            }
        });

        return { nodes, links };
    }, [blocks]);

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
            <div className="bg-base w-full max-w-5xl h-[80vh] rounded-xl shadow-2xl flex flex-col border border-outline overflow-hidden">
                <div className="flex items-center justify-between p-4 border-b border-outline">
                    <h2 className="text-lg font-semibold">Graph View</h2>
                    <button onClick={onClose} className="p-1 hover:bg-outline rounded-lg text-secondary transition-colors">
                        <X size={20} />
                    </button>
                </div>
                <div className="flex-1 flex min-h-0">
                    <SidebarTree onSelect={onClose} />
                    <div className="flex-1 overflow-hidden relative" ref={containerRef}>
                        {isOpen && (
                            <ForceGraph2D
                            width={dimensions.width}
                            height={dimensions.height}
                            graphData={graphData}
                            nodeLabel="name"
                            nodeColor="color"
                            linkDirectionalArrowLength={4}
                            linkDirectionalArrowRelPos={1}
                            linkColor={() => '#8b949e'}
                            linkDirectionalArrowColor={() => '#ffffff'}
                            onNodeClick={(node: any) => {
                                openBlockInTab(node.blockId, true);
                                onClose();
                            }}
                        />
                    )}
                    </div>
                </div>
            </div>
        </div>
    );
}
