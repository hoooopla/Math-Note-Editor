import React, { useState, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { findNearestExistingParentId, getOrderedBlocks, useStore } from "../store";
import { CodeMirrorEditor } from "./CodeMirrorEditor";
import { Trash2, FileText, Check, X, Lock, Unlock, CornerLeftUp, AlertTriangle, Link2, Pencil } from "lucide-react";
import { MathTitle } from "./MathTitle";
import { normalizeBlockLabel, normalizeBlockTitle, validateBlockMetadata } from "../lib/label-policy";
import { BacklinksPopover } from "./BacklinksPopover";
import { buildBacklinkIndex } from "../lib/backlinks";
import { isIPhoneOrIPad } from "../lib/ios-device";

const SafeRelabelModal = React.lazy(() => import("./SafeRelabelModal").then(module => ({ default: module.SafeRelabelModal })));

export const BlockContainer: React.FC<{ id: string }> = ({ id }) => {
    const block = useStore(state => state.blocksById[id]);
    const activeBlockId = useStore(state => state.activeBlockId);
    const activePath = useStore(state => state.activePath);
    const activeFocusX = useStore(state => state.activeFocusX);
    const isFocused = activeBlockId === id && (!activePath || (activePath.length === 1 && activePath[0] === block?.label));
    const focusDirection = useStore(state => state.focusDirection);
    const macros = useStore(state => state.settings?.macros) || {};

    const setActiveBlock = useStore(state => state.setActiveBlock);
    const updateBlock = useStore(state => state.updateBlock);
    const flushBlock = useStore(state => state.flushBlock);
    const deleteBlock = useStore(state => state.deleteBlock);
    const loadBlockContent = useStore(state => state.loadBlockContent);
    const blockLoadError = useStore(state => state.blockLoadErrors[id]);
    const setImageUploadParams = useStore(state => state.setImageUploadParams);

    useEffect(() => {
        if (block && block.content === undefined && !useStore.getState().blockLoadErrors[id]) {
            void loadBlockContent(id).catch(() => undefined);
        }
    }, [block?.id, block?.content, id, loadBlockContent]);

    if (block?.content === undefined && blockLoadError) return (
        <div className="mb-6 rounded-lg border border-red-400/35 bg-red-400/10 p-4 text-sm text-red-200" role="alert" data-testid={`block-load-error-${id}`}>
            <div>Could not load this note.</div>
            <div className="mt-1 break-words text-xs opacity-80">{blockLoadError}</div>
            <button type="button" className="mt-3 rounded border border-red-300/50 px-2 py-1 font-semibold hover:bg-red-300/10"
                onClick={() => { void loadBlockContent(id).catch(() => undefined); }}>
                Retry loading
            </button>
        </div>
    );
    if (!block || block.content === undefined) return <div className="h-24 animate-pulse bg-surface/50 rounded-lg mb-6 border border-outline"></div>;

    return <Block 
        block={block} 
        isFocused={isFocused} 
        focusDirection={isFocused ? focusDirection : null}
        focusX={isFocused ? activeFocusX : null}
        macros={macros}
        setActive={setActiveBlock} 
        updateBlock={updateBlock} 
        flushBlock={flushBlock}
        deleteBlock={deleteBlock} 
    />;
}

interface BlockProps {
    block: any;
    isFocused: boolean;
    focusDirection: "start" | "end" | null;
    focusX: number | null;
    macros: Record<string, string>;
    setActive: (id: string | null, dir?: "start"| "end"|null, path?: string[]|null, pos?: number|null) => void;
    updateBlock: (id: string, data: any) => void;
    flushBlock: (id: string) => Promise<void>;
    deleteBlock: (id: string) => void;
}

export function Block({ block, isFocused, focusDirection, focusX, macros, setActive, updateBlock, flushBlock, deleteBlock }: BlockProps) {
    const isViewOnlyState = useStore(state => state.viewOnlyBlocks[block.id]);
    const backendMode = useStore(state => state.backendMode);
    const nearestParentId = useStore(state => findNearestExistingParentId(block.label, state.blockIdByLabel));
    const nearestParentLabel = useStore(state => nearestParentId ? state.blocksById[nearestParentId]?.label : undefined);
    const blocksRevision = useStore(state => state.blocksRevision);
    const backlinkSourceIds = useMemo(() => {
        const state = useStore.getState();
        return buildBacklinkIndex(getOrderedBlocks(state))[block.label] || [];
    }, [block.label, blocksRevision]);
    const hasDuplicateLabel = useStore(state => state.workspaceIssues.some(issue => issue.blocks.some(candidate => candidate.id === block.id)));
    const repairDuplicateLabel = useStore(state => state.repairDuplicateLabel);
    const isIOSDevice = isIPhoneOrIPad();
    const activeTabId = useStore(state => state.activeTab);
    const isLocked = hasDuplicateLabel || (isViewOnlyState ?? (backendMode === "viewer"));
    const [mobileEditMode, setMobileEditMode] = useState(false);
    const blockRootRef = useRef<HTMLDivElement>(null);
    const mobileEditButtonRef = useRef<HTMLButtonElement>(null);
    const isTouchReading = isIOSDevice && !mobileEditMode;
    const isViewOnly = isLocked || isTouchReading;
    const hasViewerDrafts = useStore(state => Object.keys(state.viewerDraftBlockIds).length > 0);
    const resetViewerDrafts = useStore(state => state.resetViewerDrafts);
    const setImageUploadParams = useStore(state => state.setImageUploadParams);
    const [isEditingMeta, setIsEditingMeta] = useState(false);
    const [titleInput, setTitleInput] = useState(block.title);
    const [labelInput, setLabelInput] = useState(block.label);
    const [error, setError] = useState<string | null>(null);
    const [focusRequestKey, setFocusRequestKey] = useState(0);
    const [pendingRelabel, setPendingRelabel] = useState<{ oldPrefix: string, newPrefix: string } | null>(null);
    const [isRepairingLabel, setIsRepairingLabel] = useState(false);
    const [showBacklinks, setShowBacklinks] = useState(false);

    const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);

    useEffect(() => {
        if (activeTabId !== block.id || isLocked) setMobileEditMode(false);
    }, [activeTabId, block.id, isLocked]);

    useLayoutEffect(() => {
        if (!isIOSDevice || activeTabId !== block.id || isLocked) return;
        let layoutWidth = window.innerWidth;
        let layoutHeight = window.innerHeight;
        const updatePosition = () => {
            if (window.innerWidth !== layoutWidth) {
                layoutWidth = window.innerWidth;
                layoutHeight = window.innerHeight;
            } else {
                // Some mobile browsers shrink innerHeight with the keyboard.
                // Keep the pre-keyboard layout height until orientation changes.
                layoutHeight = Math.max(layoutHeight, window.innerHeight);
            }
            const viewport = window.visualViewport;
            const coveredBottom = viewport
                ? Math.max(0, layoutHeight - viewport.height - viewport.offsetTop)
                : 0;
            const button = mobileEditButtonRef.current;
            button?.style.setProperty('--keyboard-inset', `${Math.round(coveredBottom)}px`);
            const noteRight = blockRootRef.current?.getBoundingClientRect().right;
            if (button && noteRight !== undefined) {
                button.style.setProperty('--note-right', `${Math.round(Math.max(16, window.innerWidth - noteRight + 12))}px`);
            }
        };
        updatePosition();
        window.addEventListener('resize', updatePosition);
        window.visualViewport?.addEventListener('resize', updatePosition);
        window.visualViewport?.addEventListener('scroll', updatePosition);
        return () => {
            window.removeEventListener('resize', updatePosition);
            window.visualViewport?.removeEventListener('resize', updatePosition);
            window.visualViewport?.removeEventListener('scroll', updatePosition);
        };
    }, [isIOSDevice, activeTabId, block.id, isLocked]);

    const beginMetaEdit = useCallback(() => {
        if (isViewOnly) return;
        setActive(block.id, null, [block.label]);
        setTitleInput(block.title);
        setLabelInput(block.label);
        setError(null);
        setIsEditingMeta(true);
    }, [isViewOnly, block.id, block.label, block.title, setActive]);

    useLayoutEffect(() => {
        const handleEditRequest = (event: Event) => {
            const blockId = (event as CustomEvent<{ blockId?: string }>).detail?.blockId;
            if (blockId === block.id) beginMetaEdit();
        };
        window.addEventListener('math-notes-edit-block-metadata', handleEditRequest);
        return () => window.removeEventListener('math-notes-edit-block-metadata', handleEditRequest);
    }, [beginMetaEdit, block.id]);


    const handleContentChange = useCallback((val: string) => {
        updateBlock(block.id, { content: val });
    }, [block.id, updateBlock]);

    const handleContentBlur = useCallback((val: string) => {
        updateBlock(block.id, { content: val });
        void flushBlock(block.id);
    }, [block.id, flushBlock, updateBlock]);

    const handleFocus = useCallback(() => {
        if (!isFocused) {
            setActive(block.id, null, [block.label]);
        }
    }, [isFocused, block.id, block.label, setActive]);

    const submitMeta = async () => {
        const finalTitle = normalizeBlockTitle(titleInput);
        const finalLabel = normalizeBlockLabel(labelInput);
        const metadataError = validateBlockMetadata(finalTitle, finalLabel);
        if (metadataError) {
            setError(metadataError);
            return;
        }
        setError(null);
        if (finalLabel !== block.label) {
            if (hasDuplicateLabel) {
                setIsRepairingLabel(true);
                const repaired = await repairDuplicateLabel(block.id, finalLabel);
                setIsRepairingLabel(false);
                if (!repaired) {
                    setError("Could not repair this label. Check the workspace warning for details.");
                    return;
                }
                if (finalTitle !== block.title) updateBlock(block.id, { title: finalTitle });
                setIsEditingMeta(false);
                return;
            }
            if (finalTitle !== block.title) updateBlock(block.id, { title: finalTitle });
            setPendingRelabel({ oldPrefix: block.label, newPrefix: finalLabel });
        } else if (finalTitle !== block.title) {
            updateBlock(block.id, { title: finalTitle });
        }
        setIsEditingMeta(false);
    };

    const cancelMeta = () => {
        setTitleInput(block.title);
        setLabelInput(block.label);
        setError(null);
        setIsEditingMeta(false);
    };

    const handleMetaKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            // The input is removed when submitMeta opens the relabel preview.
            // Consume this keydown so its default keypress cannot continue in
            // the editor after focus returns and insert an unintended newline.
            e.preventDefault();
            e.stopPropagation();
            void submitMeta();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            cancelMeta();
        }
    };

    return (
        <div 
            ref={blockRootRef}
            data-block-root
            className={`group relative border rounded-[8px] mb-6 transition-colors bg-surface border-outline ${isFocused ? 'z-30' : 'z-0'}`}
        >


            <div 
                data-testid={`block-metadata-header-${block.id}`}
                className={`flex items-center justify-between px-4 py-2 bg-transparent border-b border-outline text-sm text-secondary cursor-text select-none rounded-t-[8px] relative ${showBacklinks ? 'z-40' : 'z-10'}`}
                onClick={(e) => {
                    e.stopPropagation();
                    if (!isEditingMeta) {
                        setActive(block.id, null, [block.label]);
                        setFocusRequestKey(key => key + 1);
                    }
                }}
                onDoubleClick={(e) => {
                    e.stopPropagation();
                    beginMetaEdit();
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
                                aria-label="Block title"
                                maxLength={512}
                                className="bg-base text-primary px-2 py-1 rounded outline-none border border-outline text-[16px] font-sans font-semibold max-w-[200px] focus:border-accent"
                                value={titleInput}
                                onChange={e => setTitleInput(e.target.value)}
                                onKeyDown={handleMetaKeyDown}
                                placeholder="Title"
                            />
                            <div className="relative flex items-center gap-2">
                                <input 
                                    aria-label="Block label"
                                    disabled={backendMode === "viewer"}
                                    maxLength={512}
                                    className={`bg-base text-secondary px-2 py-1 rounded outline-none border ${error ? 'border-red-500 focus:border-red-500' : 'border-outline focus:border-accent'} text-xs tracking-widest font-sans max-w-[150px] disabled:cursor-not-allowed disabled:opacity-60`}
                                    value={labelInput}
                                    onChange={e => {
                                        setError(null);
                                        setLabelInput(e.target.value)
                                    }}
                                    onKeyDown={handleMetaKeyDown}
                                    placeholder="Label"
                                />
                                <button 
                                    aria-label="Save block metadata"
                                    onMouseDown={e => { e.preventDefault(); void submitMeta(); }}
                                    disabled={isRepairingLabel}
                                    className="p-1 hover:bg-surface/50 text-emerald-500 rounded transition-colors disabled:opacity-50"
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
                            {hasDuplicateLabel && <span className="flex items-center gap-1 rounded border border-amber-400/40 bg-amber-400/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300" title="This label is used by more than one block"><AlertTriangle size={11}/> Duplicate label</span>}
                        </div>
                    )}
                </div>
                
                {(isFocused || isIOSDevice) && (
                    <div className="relative flex items-center gap-2">
                        {nearestParentId && nearestParentLabel && (
                            <button
                                onClick={(e) => { e.stopPropagation(); useStore.getState().goToNearestParent(); }}
                                className="text-secondary hover:text-accent transition-colors opacity-0 group-hover:opacity-100 flex items-center"
                                title={`Go to parent: ${nearestParentLabel}`}
                                aria-label={`Go to nearest parent block ${nearestParentLabel}`}
                            >
                                <CornerLeftUp size={16} />
                            </button>
                        )}
                        <button
                            type="button"
                            data-testid="backlinks-button"
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => { e.stopPropagation(); setShowBacklinks(open => !open); }}
                            className={`flex items-center gap-0.5 transition-colors ${showBacklinks ? 'text-accent opacity-100' : 'text-secondary hover:text-accent opacity-0 group-hover:opacity-100'}`}
                            title={`${backlinkSourceIds.length} backlinks`}
                            aria-label={`Show ${backlinkSourceIds.length} backlinks`}
                            aria-expanded={showBacklinks}
                        >
                            <Link2 size={16} />
                            <span className="min-w-3 rounded-full bg-accent/15 px-1 text-center text-[9px] font-semibold leading-4 text-accent">{backlinkSourceIds.length}</span>
                        </button>
                        {showBacklinks && (
                            <BacklinksPopover
                                targetLabel={block.label}
                                sourceIds={backlinkSourceIds}
                                onClose={() => setShowBacklinks(false)}
                            />
                        )}
                        {backendMode === "server" && (
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
                        )}
                        <button
                            onClick={(e) => { e.stopPropagation(); useStore.getState().toggleViewOnly(block.id); }}
                            className={`text-secondary hover:text-accent transition-colors flex items-center ${isLocked || isIOSDevice ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                            disabled={hasDuplicateLabel}
                            title={hasDuplicateLabel ? "Rename the duplicate label before editing" : isLocked ? "Unlock for editing" : "Lock for view-only"}
                        >
                            {isLocked ? <Lock size={16} /> : <Unlock size={16} />}
                        </button>
                        {backendMode !== "viewer" && !isViewOnly && (isConfirmingDelete ? (
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
                        ))}
                    </div>
                )}
            </div>

            {isIOSDevice && activeTabId === block.id && !isLocked && createPortal(
                <button
                    ref={mobileEditButtonRef}
                    type="button"
                    data-testid="mobile-edit-toggle"
                    data-mode={isTouchReading ? 'reading' : 'editing'}
                    aria-label={isTouchReading ? 'Enable editing' : 'Finish editing and read'}
                    aria-pressed={!isTouchReading}
                    title={isTouchReading ? 'Edit note' : 'Finish editing'}
                    className={`fixed z-40 flex h-14 w-14 items-center justify-center rounded-full border-2 shadow-lg shadow-black/40 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${isTouchReading ? 'border-accent bg-surface text-accent' : 'border-white/60 bg-accent text-white'}`}
                    style={{ right: 'calc(var(--note-right, 16px) + env(safe-area-inset-right))', bottom: 'calc(16px + env(safe-area-inset-bottom) + var(--keyboard-inset, 0px))' }}
                    onClick={() => {
                        if (mobileEditMode) {
                            setMobileEditMode(false);
                            setActive(null);
                            if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
                        } else {
                            setMobileEditMode(true);
                        }
                    }}
                >
                    <Pencil size={23} strokeWidth={2.4} aria-hidden="true" />
                    <span className={`absolute -right-0.5 -top-0.5 h-3.5 w-3.5 rounded-full border-2 border-surface ${isTouchReading ? 'bg-secondary' : 'bg-emerald-300'}`} aria-hidden="true" />
                </button>,
                document.body
            )}
            {backendMode === "viewer" && !isViewOnly && (
                <div className="mx-4 mt-3 flex items-center justify-between gap-3 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs text-amber-200" role="status" data-testid="viewer-draft-banner">
                    <span>Preview editing — changes stay in memory and will not be saved.</span>
                    {hasViewerDrafts && <button type="button" className="shrink-0 rounded px-2 py-1 font-semibold hover:bg-amber-400/15" onClick={resetViewerDrafts}>Reset preview changes</button>}
                </div>
            )}
            <div className="p-4 relative font-sans text-primary min-h-[3rem] z-20">
                <CodeMirrorEditor 
                    content={block.content} 
                    onBlur={handleContentBlur}
                    onChange={handleContentChange}
                    isFocused={isFocused && !isEditingMeta}
                    isReadOnly={isViewOnly} 
                    macros={macros}
                    focusDirection={focusDirection}
                    focusX={focusX}
                    focusRequestKey={focusRequestKey}
                    onFocus={handleFocus}
                    parentLabel={block.label}
                    visitedLabels={[block.label]}
                    onImagePaste={backendMode === "viewer" ? undefined : (file, insertContent, assertInsertable) => setImageUploadParams({ file, onInsert: insertContent, assertInsertable })}
                />
            </div>
            {pendingRelabel && <React.Suspense fallback={<RelabelLoading onCancel={() => setPendingRelabel(null)}/>}><SafeRelabelModal
                oldPrefix={pendingRelabel.oldPrefix}
                newPrefix={pendingRelabel.newPrefix}
                onClose={(completed) => {
                    if (!completed) setLabelInput(block.label);
                    setPendingRelabel(null);
                }}
            /></React.Suspense>}
        </div>
    )
}

function RelabelLoading({ onCancel }: { onCancel: () => void }) {
    useEffect(() => {
        const cancel = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            onCancel();
        };
        window.addEventListener('keydown', cancel);
        return () => window.removeEventListener('keydown', cancel);
    }, [onCancel]);
    return <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 text-sm text-secondary" role="status">Loading label preview…</div>;
}
