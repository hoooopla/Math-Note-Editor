import React, { useMemo, useRef, useEffect } from 'react';
import { useStore } from '../store';
import { X } from 'lucide-react';
import ForceGraph2D from 'react-force-graph-2d';
import { SidebarTree } from './LabelTree';
import { splitPath } from '../lib/utils/path';

export function GraphModal({ isOpen, onClose }: { isOpen: boolean, onClose: () => void }) {
    const { blocks, openBlockInTab } = useStore();
    const containerRef = useRef<HTMLDivElement>(null);
    const fgRef = useRef<any>(null);
    const [dimensions, setDimensions] = React.useState({ width: 800, height: 600 });
    const [hoveredNodeId, setHoveredNodeId] = React.useState<string | null>(null);
    const hoverSourceRef = useRef<'tree' | 'graph' | null>(null);

    useEffect(() => {
        if (isOpen && containerRef.current) {
            setDimensions({
                width: containerRef.current.clientWidth,
                height: containerRef.current.clientHeight
            });
        }
        if (isOpen && fgRef.current) {
            // Make the group of nodes closer to each other
            fgRef.current.d3Force('charge').strength(-30);
            fgRef.current.d3Force('link').distance(60);
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
                val: Math.max(0.5, 4 - depth * 1.5), // Make root nodes significantly larger
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

    useEffect(() => {
        if (hoverSourceRef.current === 'tree' && hoveredNodeId && fgRef.current && isOpen) {
            const nodes = graphData.nodes;
            const node = nodes.find((n: any) => n.id === hoveredNodeId);
            if (node && node.x !== undefined && node.y !== undefined) {
                fgRef.current.centerAt(node.x, node.y, 300);
            }
        }
    }, [hoveredNodeId, isOpen, graphData.nodes]);

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
                    <SidebarTree 
                        onSelect={onClose} 
                        hoveredNodeId={hoveredNodeId}
                        onNodeHover={(id) => {
                            hoverSourceRef.current = 'tree';
                            setHoveredNodeId(id);
                        }}
                    />
                    <div className="flex-1 overflow-hidden relative" ref={containerRef}>
                        {isOpen && (
                            <ForceGraph2D
                            ref={fgRef}
                            width={dimensions.width}
                            height={dimensions.height}
                            graphData={graphData}
                            nodeLabel={() => null}
                            nodeColor="color"
                            onNodeHover={(node: any) => {
                                hoverSourceRef.current = 'graph';
                                setHoveredNodeId(node ? node.id : null);
                            }}
                            onRenderFramePost={(ctx, globalScale) => {
                                if (hoveredNodeId) {
                                    const nodes = graphData.nodes;
                                    const node = nodes.find((n: any) => n.id === hoveredNodeId);
                                    if (node && node.x !== undefined && node.y !== undefined) {
                                        const r = Math.sqrt(Math.max(0, node.val || 1)) * 4;
                                        
                                        const title = node.name;
                                        const label = node.id;
                                        
                                        const fontSize = 12 / globalScale;
                                        const labelFontSize = 11 / globalScale;
                                        ctx.font = `bold ${fontSize}px Sans-Serif`;
                                        const titleWidth = ctx.measureText(title).width;
                                        ctx.font = `${labelFontSize}px Sans-Serif`;
                                        const labelWidth = ctx.measureText(label).width;
                                        
                                        const textWidth = Math.max(titleWidth, labelWidth);
                                        const padding = 8 / globalScale;
                                        const boxWidth = textWidth + padding * 2;
                                        const boxHeight = fontSize + labelFontSize + padding * 2.5;
                                        
                                        const boxX = node.x - boxWidth / 2;
                                        const boxY = node.y - r - boxHeight - (8 / globalScale);

                                        ctx.save();
                                        
                                        ctx.fillStyle = '#0f1115'; // base color
                                        
                                        ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
                                        ctx.shadowBlur = 8 / globalScale;
                                        ctx.shadowOffsetX = 0;
                                        ctx.shadowOffsetY = 4 / globalScale;
                                        
                                        ctx.beginPath();
                                        if (ctx.roundRect) {
                                            ctx.roundRect(boxX, boxY, boxWidth, boxHeight, 4 / globalScale);
                                        } else {
                                            ctx.rect(boxX, boxY, boxWidth, boxHeight);
                                        }
                                        ctx.fill();
                                        
                                        ctx.shadowColor = 'transparent';
                                        ctx.strokeStyle = '#30363d'; // outline
                                        ctx.lineWidth = 1 / globalScale;
                                        ctx.stroke();

                                        ctx.textAlign = 'center';
                                        ctx.textBaseline = 'top';
                                        
                                        ctx.fillStyle = '#ffffff'; // primary text
                                        ctx.font = `bold ${fontSize}px Sans-Serif`;
                                        ctx.fillText(title, node.x, boxY + padding);
                                        
                                        ctx.fillStyle = '#8b949e'; // secondary text
                                        ctx.font = `${labelFontSize}px Sans-Serif`;
                                        ctx.fillText(label, node.x, boxY + padding + fontSize + padding * 0.5);
                                        
                                        ctx.restore();
                                    }
                                }
                            }}
                            nodeCanvasObjectMode={() => 'after'}
                            nodeCanvasObject={(node: any, ctx, globalScale) => {
                                if (node.id === hoveredNodeId) {
                                    const r = Math.sqrt(Math.max(0, node.val || 1)) * 4;
                                    ctx.beginPath();
                                    ctx.arc(node.x, node.y, r + (3 / Math.max(1, globalScale)), 0, 2 * Math.PI, false);
                                    ctx.strokeStyle = '#ffffff';
                                    ctx.lineWidth = 2 / Math.max(1, globalScale);
                                    ctx.stroke();
                                }
                            }}
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
