import React, { useState, useCallback, useEffect } from "react";
import type { PointerEvent } from "react";
import { useStore } from "../store";
import { CodeMirrorEditor } from "./CodeMirrorEditor";
import { Trash2, FileText, Check, X } from "lucide-react";
import { MathTitle } from "./MathTitle";

export const BlockContainer: React.FC<{ id: string, index: number }> = ({ id, index }) => {
    const block = useStore(state => state.blocks.find(b => b.id === id));
    const blocks = useStore(state => state.blocks);
    const activeBlockId = useStore(state => state.activeBlockId);
    const activePath = useStore(state => state.activePath);
    const isFocused = activeBlockId === id && (!activePath || (activePath.length === 1 && activePath[0] === block?.label));
    const focusDirection = useStore(state => state.focusDirection);
    const macros = useStore(state => state.settings?.macros || {});

    const { setActiveBlock, updateBlock, deleteBlock, loadBlockContent, setImageUploadParams } = useStore();

    useEffect(() => {
        if (block && block.content === undefined) {
            loadBlockContent(id);
        }
    }, [block, id, loadBlockContent]);

    const onUp = useCallback(() => {
        if (index > 0) setActiveBlock(blocks[index - 1].id, "end", [blocks[index - 1].label]);
    }, [index, blocks, setActiveBlock]);

    const onDown = useCallback(() => {
        if (index < blocks.length - 1) setActiveBlock(blocks[index + 1].id, "start", [blocks[index + 1].label]);
        else if (index === blocks.length - 1) useStore.getState().addBlock(index);
    }, [index, blocks, setActiveBlock]);

    if (!block || block.content === undefined) return <div className="h-24 animate-pulse bg-surface/50 rounded-lg mb-6 border border-outline"></div>;

    return <Block 
        block={block} 
        blocks={blocks}
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
    blocks: any[];
    isFocused: boolean;
    focusDirection: "start" | "end" | null;
    macros: Record<string, string>;
    setActive: (id: string | null, dir?: "start"| "end"|null, path?: string[]|null, pos?: number|null) => void;
    onUp: () => void;
    onDown: () => void;
    updateBlock: (id: string, data: any) => void;
    deleteBlock: (id: string) => void;
}

export function Block({ block, blocks, isFocused, focusDirection, macros, setActive, onUp, onDown, updateBlock, deleteBlock }: BlockProps) {
    const setImageUploadParams = useStore(state => state.setImageUploadParams);
    const [isEditingMeta, setIsEditingMeta] = useState(false);
    const [titleInput, setTitleInput] = useState(block.title);
    const [labelInput, setLabelInput] = useState(block.label);
    const [error, setError] = useState<string | null>(null);

    const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);

    const handleContentChange = useCallback((val: string) => {
        updateBlock(block.id, { content: val });
    }, [block.id, updateBlock]);

    const handleFocus = useCallback(() => {
        if (!isFocused) {
            setActive(block.id, null, [block.label]);
        }
    }, [isFocused, block.id, block.label, setActive]);

    const submitMeta = () => {
        let finalLabel = labelInput.trim() || block.id.substring(0, 8);
        if (finalLabel !== block.label) {
            const isDuplicate = blocks.some(b => b.id !== block.id && b.label === finalLabel);
            if (isDuplicate) {
                setError(`Label "${finalLabel}" already exists`);
                return;
            }
        }
        setError(null);
        updateBlock(block.id, { title: titleInput.trim(), label: finalLabel });
        setIsEditingMeta(false);
    };

    const cancelMeta = () => {
        setTitleInput(block.title);
        setLabelInput(block.label);
        setError(null);
        setIsEditingMeta(false);
    };

    const handleMetaKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') submitMeta();
        if (e.key === 'Escape') cancelMeta();
    };

    return (
        <div 
            className={`group relative border rounded-[8px] mb-6 transition-colors bg-surface border-outline ${isFocused ? 'z-30' : 'z-0'}`}
        >


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
                                    cancelMeta();
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
                            <div className="relative flex items-center gap-2">
                                <input 
                                    className={`bg-base text-secondary px-2 py-1 rounded outline-none border ${error ? 'border-red-500 focus:border-red-500' : 'border-outline focus:border-accent'} text-xs tracking-widest font-sans max-w-[150px]`}
                                    value={labelInput}
                                    onChange={e => {
                                        setError(null);
                                        setLabelInput(e.target.value.replace(/[\[\]\|]/g, ''))
                                    }}
                                    onKeyDown={handleMetaKeyDown}
                                    placeholder="Label"
                                />
                                <button 
                                    onMouseDown={e => { e.preventDefault(); submitMeta(); }}
                                    className="p-1 hover:bg-surface/50 text-emerald-500 rounded transition-colors"
                                >
                                    <Check size={16} />
                                </button>
                                <button 
                                    onMouseDown={e => { e.preventDefault(); cancelMeta(); }}
                                    className="p-1 hover:bg-surface/50 text-secondary rounded transition-colors"
                                >
                                    <X size={16} />
                                </button>
                                {error && (
                                    <span className="absolute left-full ml-2 whitespace-nowrap text-xs text-red-500 font-sans">
                                        {error}
                                    </span>
                                )}
                            </div>
                        </div>
                    ) : (
                        <div className="flex items-center gap-3 font-sans text-[11px] text-secondary transition-colors">
                            <MathTitle text={block.title} className="font-sans text-[16px] font-bold text-primary transition-colors" />
                            <span className="font-sans text-[11px] bg-transparent border border-outline px-1.5 py-0.5 rounded text-secondary tracking-widest">
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
                        {isConfirmingDelete ? (
                            <div className="flex items-center gap-1 opacity-100 bg-red-500/10 text-red-500 rounded px-2 py-0.5" onClick={e => e.stopPropagation()}>
                                <span className="text-xs font-sans mr-1">Delete?</span>
                                <button onClick={() => deleteBlock(block.id)} className="hover:text-red-400 p-0.5"><Check size={14} /></button>
                                <button onClick={() => setIsConfirmingDelete(false)} className="hover:text-secondary p-0.5"><X size={14} /></button>
                            </div>
                        ) : (
                            <button 
                                 onClick={(e) => { e.stopPropagation(); setIsConfirmingDelete(true); }}
                                 className="text-secondary hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100"
                                 title="Delete Block"
                            >
                                <Trash2 size={16} />
                            </button>
                        )}
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
                    onImagePaste={(file, insertContent) => setImageUploadParams({ file, onInsert: insertContent })}
                />
            </div>
        </div>
    )
}
