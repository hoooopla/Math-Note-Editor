import React, { useState, useCallback } from "react";
import type { PointerEvent } from "react";
import { useStore } from "../store";
import { CodeMirrorEditor } from "./CodeMirrorEditor";
import { GripVertical, Trash2, FileText } from "lucide-react";

export const BlockContainer: React.FC<{ id: string, index: number }> = ({ id, index }) => {
    const block = useStore(state => state.blocks.find(b => b.id === id));
    const activeBlockId = useStore(state => state.activeBlockId);
    const activePath = useStore(state => state.activePath);
    const isFocused = activeBlockId === id && (!activePath || (activePath.length === 1 && activePath[0] === block?.label));
    const focusDirection = useStore(state => state.focusDirection);
    const macros = useStore(state => state.macros);

    const { setActiveBlock, updateBlock, deleteBlock, blocks } = useStore();

    const onUp = useCallback(() => {
        if (index > 0) setActiveBlock(blocks[index - 1].id, "end", [blocks[index - 1].label]);
    }, [index, blocks, setActiveBlock]);

    const onDown = useCallback(() => {
        if (index < blocks.length - 1) setActiveBlock(blocks[index + 1].id, "start", [blocks[index + 1].label]);
        else if (index === blocks.length - 1) useStore.getState().addBlock(index);
    }, [index, blocks, setActiveBlock]);

    if (!block) return null;

    return <Block 
        block={block} 
        isFocused={isFocused} 
        focusDirection={isFocused ? focusDirection : null}
        macros={macros}
        setActive={setActiveBlock} 
        onUp={onUp} 
        onDown={onDown} 
        updateBlock={updateBlock} 
        deleteBlock={deleteBlock} 
    />;
}

interface BlockProps {
    block: any;
    isFocused: boolean;
    focusDirection: "start" | "end" | null;
    macros: Record<string, string>;
    setActive: (id: string | null, dir?: "start"| "end"|null, path?: string[]|null, pos?: number|null) => void;
    onUp: () => void;
    onDown: () => void;
    updateBlock: (id: string, data: any) => void;
    deleteBlock: (id: string) => void;
}

export function Block({ block, isFocused, focusDirection, macros, setActive, onUp, onDown, updateBlock, deleteBlock }: BlockProps) {
    const [isEditingMeta, setIsEditingMeta] = useState(false);
    const [titleInput, setTitleInput] = useState(block.title);
    const [labelInput, setLabelInput] = useState(block.label);

    const handleContentChange = useCallback((val: string) => {
        updateBlock(block.id, { content: val });
    }, [block.id, updateBlock]);

    const handleFocus = useCallback(() => {
        if (!isFocused) {
            setActive(block.id, null, [block.label]);
        }
    }, [isFocused, block.id, block.label, setActive]);

    const submitMeta = () => {
        updateBlock(block.id, { title: titleInput, label: labelInput });
        setIsEditingMeta(false);
    };

    const handleMetaKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') submitMeta();
        if (e.key === 'Escape') {
            setTitleInput(block.title);
            setLabelInput(block.label);
            setIsEditingMeta(false);
        }
    };

    return (
        <div 
            className={`group relative border rounded-[8px] mb-6 transition-colors ${isFocused ? 'bg-surface border-accent shadow-[0_0_0_1px_var(--color-accent)] z-30' : 'bg-surface border-outline hover:border-outline/80 z-0'}`}
        >
            <div 
                className="absolute left-0 top-10 opacity-0 group-hover:opacity-100 transition-opacity cursor-grab -translate-x-full pr-2 text-secondary hidden md:block"
                contentEditable={false}
            >
                <GripVertical size={18} />
            </div>

            <div 
                className="flex items-center justify-between px-4 py-2 bg-transparent border-b border-outline text-sm text-secondary cursor-text select-none rounded-t-[8px] relative z-10"
                onClick={(e) => {
                    e.stopPropagation();
                    if (!isEditingMeta) setActive(block.id, null);
                }}
                onDoubleClick={(e) => {
                    e.stopPropagation();
                    setTitleInput(block.title);
                    setLabelInput(block.label);
                    setIsEditingMeta(true);
                }}
            >
                <div className="flex-1">
                    {isEditingMeta ? (
                        <div 
                            className="flex space-x-2 items-center"
                            onBlur={(e) => {
                                if (!e.currentTarget.contains(e.relatedTarget)) {
                                    submitMeta();
                                }
                            }}
                        >
                            <input 
                                autoFocus
                                className="bg-base text-primary px-2 py-1 rounded outline-none border border-outline text-[16px] font-sans font-semibold max-w-[200px] focus:border-accent"
                                value={titleInput}
                                onChange={e => setTitleInput(e.target.value.replace(/[\[\]\|]/g, ''))}
                                onKeyDown={handleMetaKeyDown}
                                placeholder="Title"
                            />
                            <input 
                                className="bg-base text-secondary px-2 py-1 rounded outline-none border border-outline text-xs uppercase tracking-widest font-sans max-w-[150px] focus:border-accent"
                                value={labelInput}
                                onChange={e => setLabelInput(e.target.value.replace(/\s+/g, '-').replace(/[\[\]\|]/g, ''))}
                                onKeyDown={handleMetaKeyDown}
                                placeholder="Label"
                            />
                        </div>
                    ) : (
                        <div className="flex items-center gap-3 font-sans text-[11px] text-secondary transition-colors">
                            <span className="font-sans text-[16px] font-bold text-primary group-hover:text-accent transition-colors">{block.title || 'Untitled'}</span>
                            <span className="font-sans text-[11px] bg-transparent border border-outline px-1.5 py-0.5 rounded text-secondary uppercase tracking-widest">
                                {block.label || 'label'}
                            </span>
                        </div>
                    )}
                </div>
                
                {isFocused && (
                    <div className="flex items-center gap-2">
                        <a 
                            href={`/api/blocks/${block.id}/raw`} 
                            target="_blank" 
                            rel="noopener noreferrer"
                            className="text-secondary hover:text-accent transition-colors opacity-0 group-hover:opacity-100 flex items-center"
                            title="View Raw Markdown"
                            onClick={e => e.stopPropagation()}
                        >
                            <FileText size={16} />
                        </a>
                        <button 
                             onClick={(e) => { e.stopPropagation(); deleteBlock(block.id); }}
                             className="text-secondary hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100"
                             title="Delete Block"
                        >
                            <Trash2 size={16} />
                        </button>
                    </div>
                )}
            </div>

            <div className="p-4 relative font-sans text-primary min-h-[3rem] z-20">
                <CodeMirrorEditor 
                    content={block.content} 
                    onBlur={handleContentChange} 
                    onChange={handleContentChange}
                    onUp={onUp} 
                    onDown={onDown} 
                    isFocused={isFocused && !isEditingMeta} 
                    macros={macros}
                    focusDirection={focusDirection}
                    onFocus={handleFocus}
                    parentLabel={block.label}
                    visitedLabels={[block.label]}
                />
            </div>
        </div>
    )
}
