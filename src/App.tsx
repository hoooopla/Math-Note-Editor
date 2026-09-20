/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo, useRef } from "react";
import { getOrderedBlocks, useStore } from "./store";
import { BlockContainer } from "./components/Block";
import { Search, Plus, X, Settings, FolderOpen, Command, FileText, Loader2, Network, FlaskConical, AlertTriangle, Boxes } from "lucide-react";
import "./index.css";

const SettingsModal = React.lazy(() => import("./components/SettingsModal").then(module => ({ default: module.SettingsModal })));
const ImageUploadModal = React.lazy(() => import("./components/ImageUploadModal").then(module => ({ default: module.ImageUploadModal })));
const SearchModal = React.lazy(() => import("./components/SearchModal").then(module => ({ default: module.SearchModal })));
const WorkspaceIssuesModal = React.lazy(() => import("./components/WorkspaceIssuesModal").then(module => ({ default: module.WorkspaceIssuesModal })));
const GraphModal = React.lazy(() =>
    import("./components/GraphModal").then(module => ({ default: module.GraphModal }))
);
const BlockMapModal = React.lazy(() =>
    import("./components/BlockMapModal").then(module => ({ default: module.BlockMapModal }))
);

const shortcutMatches = (event: KeyboardEvent, shortcut: string) => {
    const parts = shortcut.toLowerCase().split('+').map(part => part.trim()).filter(Boolean);
    const key = parts.at(-1);
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
    const requiresMod = parts.includes('mod');
    const requiresCtrl = parts.includes('ctrl') || (requiresMod && !isMac);
    const requiresMeta = parts.includes('cmd') || parts.includes('meta') || (requiresMod && isMac);
    const requiresShift = parts.includes('shift');
    const requiresAlt = parts.includes('alt');
    const pressedKey = event.key === ' ' ? 'space' : event.key.toLowerCase();
    return pressedKey === key
        && event.ctrlKey === requiresCtrl
        && event.metaKey === requiresMeta
        && event.shiftKey === requiresShift
        && event.altKey === requiresAlt;
};

export default function App() {
    const fileInputRef = React.useRef<HTMLInputElement>(null);
    const loadViewerFiles = useStore(state => state.loadViewerFiles);
    const blocksRevision = useStore(state => state.blocksRevision);
    const blocks = useMemo(() => getOrderedBlocks(useStore.getState()), [blocksRevision]);
    const backendMode = useStore(state => state.backendMode);
    const isLoaded = useStore(state => state.isLoaded);
    const isLoadingFiles = useStore(state => state.isLoadingFiles);
    const addBlock = useStore(state => state.addBlock);
    const setActiveBlock = useStore(state => state.setActiveBlock);
    const initBackend = useStore(state => state.initBackend);
    const connectLocalFS = useStore(state => state.connectLocalFS);
    const openTabs = useStore(state => state.openTabs);
    const activeTab = useStore(state => state.activeTab);
    const setOpenTabs = useStore(state => state.setOpenTabs);
    const setActiveTab = useStore(state => state.setActiveTab);
    const activateRootBlock = useStore(state => state.activateRootBlock);
    const activateTab = useStore(state => state.activateTab);
    const closeStoreTab = useStore(state => state.closeTab);
    const settings = useStore(state => state.settings);
    const persistenceError = useStore(state => state.persistenceError);
    const workspaceIssues = useStore(state => state.workspaceIssues);
    const imageUploadParams = useStore(state => state.imageUploadParams);
    const setImageUploadParams = useStore(state => state.setImageUploadParams);
    const clearPersistenceError = useStore(state => state.clearPersistenceError);
    const flushBlock = useStore(state => state.flushBlock);
    const flushPendingSaves = useStore(state => state.flushPendingSaves);
    const [isMacroModalOpen, setIsMacroModalOpen] = useState(false);
    const [isSearchModalOpen, setIsSearchModalOpen] = useState(false);
    const [isGraphModalOpen, setIsGraphModalOpen] = useState(false);
    const [isBlockMapOpen, setIsBlockMapOpen] = useState(false);
    const [isTestMode, setIsTestMode] = useState(false);
    const [isDesktop, setIsDesktop] = useState(false);
    const [isWorkspaceIssuesOpen, setIsWorkspaceIssuesOpen] = useState(false);
    const previousWorkspaceIssueCount = useRef(0);
    
    // Drag state for tabs
    const [draggedTab, setDraggedTab] = useState<string | null>(null);

    useEffect(() => {
        initBackend();
    }, [initBackend]);

    useEffect(() => {
        if (workspaceIssues.length > 0 && previousWorkspaceIssueCount.current === 0) {
            setIsWorkspaceIssuesOpen(true);
        }
        previousWorkspaceIssueCount.current = workspaceIssues.length;
    }, [workspaceIssues.length]);

    useEffect(() => {
        fetch('/api/runtime')
            .then(response => response.ok ? response.json() : null)
            .then(runtime => {
                setIsTestMode(runtime?.testMode === true);
                setIsDesktop(runtime?.desktop === true);
            })
            .catch(() => {
                setIsTestMode(false);
                setIsDesktop(false);
            });
    }, []);

    useEffect(() => {
        return window.mathNotesDesktop?.onCommand(command => {
            if (command === 'close-tab') {
                const current = useStore.getState().activeTab;
                if (current) void useStore.getState().closeTab(current);
            } else if (command === 'reopen-tab') {
                useStore.getState().reopenClosedTab();
            } else if (command === 'next-tab') {
                useStore.getState().cycleTab(1);
            } else if (command === 'previous-tab') {
                useStore.getState().cycleTab(-1);
            } else if (command === 'go-to-parent') {
                useStore.getState().goToNearestParent();
            }
        });
    }, []);

    useEffect(() => {
        return window.mathNotesDesktop?.onPrepareWorkspaceChange(() => useStore.getState().flushPendingSaves());
    }, []);

    useEffect(() => {
        const handlePageHide = () => { void flushPendingSaves(); };
        const handleVisibilityChange = () => {
            if (document.visibilityState === 'hidden') void flushPendingSaves();
        };

        window.addEventListener('pagehide', handlePageHide);
        document.addEventListener('visibilitychange', handleVisibilityChange);
        return () => {
            window.removeEventListener('pagehide', handlePageHide);
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, [flushPendingSaves]);

    useEffect(() => {
        if (!isLoaded) return;
        const validTabs = openTabs.filter(t => blocks.some(b => b.id === t));
        if (validTabs.length !== openTabs.length) {
            setOpenTabs(validTabs);
            if (activeTab && !validTabs.includes(activeTab)) {
                const fallback = validTabs[validTabs.length - 1];
                if (fallback) activateRootBlock(fallback);
                else {
                    setActiveTab(null);
                    setActiveBlock(null);
                }
            }
        }
    }, [isLoaded, blocks, openTabs, activeTab, setOpenTabs, setActiveTab, setActiveBlock, activateRootBlock]);

    useEffect(() => {
        if (openTabs.length === 0 && blocks.length > 0) {
            const welcome = blocks.find(b => b.label === "showcase:main");
            const first = welcome || blocks[0];
            if (first) {
                activateRootBlock(first.id);
            }
        }
    }, [blocks, openTabs.length, activateRootBlock]);

    useEffect(() => {
        window.mathNotesDesktop?.updateShortcuts({
            closeTab: settings.closeTabShortcut || 'mod+w',
            reopenTab: settings.reopenClosedTabShortcut || 'mod+shift+t',
            nextTab: settings.nextTabShortcut || 'ctrl+tab',
            previousTab: settings.previousTabShortcut || 'ctrl+shift+tab',
            goToParent: settings.goToParentShortcut || 'mod+shift+arrowup'
        });
    }, [settings.closeTabShortcut, settings.reopenClosedTabShortcut, settings.nextTabShortcut, settings.previousTabShortcut, settings.goToParentShortcut]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                if (isMacroModalOpen) setIsMacroModalOpen(false);
                else if (isSearchModalOpen) setIsSearchModalOpen(false);
                else if (isGraphModalOpen) setIsGraphModalOpen(false);
                else if (isBlockMapOpen) setIsBlockMapOpen(false);
                else if (isWorkspaceIssuesOpen) setIsWorkspaceIssuesOpen(false);
                else if (imageUploadParams) setImageUploadParams(null);
                else return;
                e.preventDefault();
                return;
            }
            if (shortcutMatches(e, settings.searchShortcut || 'meta+k')) {
                e.preventDefault();
                setIsSearchModalOpen(true);
                return;
            }

            if (!isMacroModalOpen && !isSearchModalOpen && !isGraphModalOpen && !isBlockMapOpen
                && shortcutMatches(e, settings.editMetadataShortcut || 'f2')) {
                const rootBlockId = useStore.getState().activeTab;
                if (rootBlockId) {
                    e.preventDefault();
                    window.dispatchEvent(new CustomEvent('math-notes-edit-block-metadata', {
                        detail: { blockId: rootBlockId }
                    }));
                }
                return;
            }

            if (!isMacroModalOpen && !isSearchModalOpen && !isGraphModalOpen && !isBlockMapOpen
                && shortcutMatches(e, settings.goToParentShortcut || 'mod+shift+arrowup')) {
                if (useStore.getState().goToNearestParent()) e.preventDefault();
                return;
            }

            // Electron owns these accelerators so they continue working even
            // when an editor input has focus. The browser fallback supports
            // custom combinations that are not reserved by the browser.
            if (window.mathNotesDesktop) return;
            const state = useStore.getState();
            if (shortcutMatches(e, settings.closeTabShortcut || 'mod+w')) {
                if (state.activeTab) void state.closeTab(state.activeTab);
            } else if (shortcutMatches(e, settings.reopenClosedTabShortcut || 'mod+shift+t')) {
                state.reopenClosedTab();
            } else if (shortcutMatches(e, settings.nextTabShortcut || 'ctrl+tab')) {
                state.cycleTab(1);
            } else if (shortcutMatches(e, settings.previousTabShortcut || 'ctrl+shift+tab')) {
                state.cycleTab(-1);
            } else return;
            e.preventDefault();
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [settings.searchShortcut, settings.editMetadataShortcut, settings.goToParentShortcut, settings.closeTabShortcut, settings.reopenClosedTabShortcut, settings.nextTabShortcut, settings.previousTabShortcut, isMacroModalOpen, isSearchModalOpen, isGraphModalOpen, isBlockMapOpen, isWorkspaceIssuesOpen, imageUploadParams, setImageUploadParams]);

    const closeTab = (id: string, e?: React.SyntheticEvent) => {
        e?.stopPropagation();
        void closeStoreTab(id);
    };

    const tabRefs = useRef(new Map<string, HTMLDivElement>());
    const handleTabKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, id: string) => {
        const currentIndex = openTabs.indexOf(id);
        let nextIndex: number | null = null;
        if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + openTabs.length) % openTabs.length;
        if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % openTabs.length;
        if (event.key === 'Home') nextIndex = 0;
        if (event.key === 'End') nextIndex = openTabs.length - 1;
        if (nextIndex !== null) {
            event.preventDefault();
            tabRefs.current.get(openTabs[nextIndex])?.focus();
            return;
        }
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            activateTab(id);
        } else if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault();
            closeTab(id, event);
        }
    };

    const handleDragStart = (e: React.DragEvent, id: string) => {
        setDraggedTab(id);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', id); // needed for Firefox
        
        // Slightly delay hiding the dragged element visually if needed
        const target = e.currentTarget as HTMLElement;
        setTimeout(() => {
            target.style.opacity = '0.5';
        }, 0);
    };

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault(); // Necessary to allow dropping
        e.dataTransfer.dropEffect = 'move';
    };

    const handleDrop = (e: React.DragEvent, targetId: string) => {
        e.preventDefault();
        e.currentTarget.style.opacity = '1';
        
        if (!draggedTab || draggedTab === targetId) {
            setDraggedTab(null);
            return;
        }
        
        const newTabs = [...openTabs];
        const dragIndex = newTabs.indexOf(draggedTab);
        const dropIndex = newTabs.indexOf(targetId);
        
        newTabs.splice(dragIndex, 1);
        newTabs.splice(dropIndex, 0, draggedTab);
        
        setOpenTabs(newTabs);
        setDraggedTab(null);
    };

    const handleDragEnd = (e: React.DragEvent) => {
        e.currentTarget.style.opacity = '1';
        setDraggedTab(null);
    };

    return (
        <div 
            className="min-h-screen bg-base text-primary font-sans flex flex-col h-screen overflow-hidden selection:bg-accent/30 selection:text-white"
            style={{ 
                "--math-highlight-color": settings.mathHighlightColor || "#d19a66",
                "--math-color-command": settings.mathColors?.command || "#61afef",
                "--math-color-brace": settings.mathColors?.brace || "#e5c07b",
                "--math-color-script": settings.mathColors?.script || "#c678dd",
                "--math-color-comment": settings.mathColors?.comment || "#8b949e",
                "--math-color-delimiter": settings.mathColors?.delimiter || "#98c379",
                "--math-color-align": settings.mathColors?.align || "#e06c75",
                "--math-color-escaped": settings.mathColors?.escaped || "#56b6c2",
                "--math-block-padding-y": `${settings.mathBlockPaddingY ?? 4}px`
            } as React.CSSProperties}
        >
            <div className="flex h-12 bg-surface border-b border-outline items-center px-4 justify-between shrink-0">
                <div className="flex items-center gap-4">
                    <h1 className="text-[16px] font-bold tracking-tight text-primary flex items-center gap-2">
                        <Command className="text-accent" size={20} />
                        {isTestMode && (
                            <span
                                className="flex items-center gap-1 rounded border border-amber-400/40 bg-amber-400/10 px-1.5 py-0.5 text-[10px] font-semibold tracking-wider text-amber-300"
                                title="Test mode: edits are stored in memory and discarded when the server stops"
                                aria-label="In-memory test mode"
                            >
                                <FlaskConical size={13} aria-hidden="true" /> TEST
                            </span>
                        )}
                        {isDesktop && (
                            <span className="rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[10px] font-semibold tracking-wider text-accent" aria-label="Desktop application">
                                DESKTOP
                            </span>
                        )}
                        NoteFlow
                    </h1>
                </div>

                <div className="flex items-center gap-2">
{backendMode === "none" && (
                        <div className="flex items-center gap-2">
                            <button 
                                onClick={() => connectLocalFS()}
                                disabled={isLoadingFiles}
                                className="px-3 py-1.5 bg-accent/20 text-accent rounded-lg font-medium text-sm hover:bg-accent/30 transition-colors flex items-center gap-2 mr-2 disabled:opacity-50"
                            >
                                {isLoadingFiles ? <Loader2 size={16} className="animate-spin" /> : <FolderOpen size={16} />} 
                                Open Workspace
                            </button>
                            <input 
                                type="file" 
                                ref={fileInputRef} 
                                style={{display: 'none'}} 
                                webkitdirectory="" 
                                onChange={(e) => {
                                    if (e.target.files && e.target.files.length > 0) {
                                        loadViewerFiles(e.target.files);
                                    }
                                }}
                            />
                            <button 
                                onClick={() => fileInputRef.current?.click()}
                                disabled={isLoadingFiles}
                                className="px-3 py-1.5 border border-outline hover:bg-outline rounded-lg font-medium text-sm transition-colors flex items-center gap-2 mr-2 disabled:opacity-50"
                                title="Read-only viewer (Works on iPad)"
                            >
                                {isLoadingFiles ? <Loader2 size={16} className="animate-spin" /> : <FileText size={16} />} 
                                Read-Only Viewer
                            </button>
                        </div>
                    )}
                    <button 
                        onClick={() => setIsSearchModalOpen(true)}
                        className="px-3 py-1.5 text-secondary hover:text-primary hover:bg-outline rounded flex items-center gap-2 text-sm transition-colors border border-transparent hover:border-outline"
                    >
                        <Search size={16} /> Search <kbd className="text-xs font-mono bg-base px-1.5 rounded ml-1 border border-outline shadow-sm">{settings.searchShortcut || 'meta+k'}</kbd>
                    </button>
                    <button 
                        onClick={() => setIsGraphModalOpen(true)}
                        className="p-1.5 hover:bg-accent/20 rounded text-secondary hover:text-accent transition-colors"
                        title="Graph View"
                        aria-label="Open graph view"
                    >
                        <Network size={18} />
                    </button>
                    <button
                        onClick={() => setIsBlockMapOpen(true)}
                        className="p-1.5 hover:bg-accent/20 rounded text-secondary hover:text-accent transition-colors"
                        title="Blocks View"
                        aria-label="Open blocks view"
                    >
                        <Boxes size={18} />
                    </button>
                    <div className="w-px h-6 bg-outline mx-1"></div>
                    <button 
                        onClick={() => setIsMacroModalOpen(true)}
                        className="p-1.5 hover:bg-accent/20 rounded text-secondary hover:text-accent transition-colors"
                        title="Settings"
                        aria-label="Open settings"
                    >
                        <Settings size={18} />
                    </button>
                    {backendMode !== "viewer" && (
                        <button 
                            onClick={async () => {
                                const newBlock = await addBlock();
                                if (newBlock) {
                                    activateRootBlock(newBlock.id, "start");
                                }
                            }}
                            className="p-1.5 hover:bg-accent/20 rounded text-accent transition-colors"
                            title="New Block"
                            aria-label="Create new block"
                        >
                            <Plus size={18} />
                        </button>
                    )}
                </div>
            </div>

            {persistenceError && (
                <div className="mx-4 mt-3 flex items-center justify-between gap-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300" role="alert">
                    <span>Changes may not have been saved: {persistenceError}</span>
                    <div className="flex shrink-0 items-center gap-2">
                        <button
                            onClick={() => { clearPersistenceError(); void initBackend(); }}
                            className="rounded px-2 py-1 font-medium hover:bg-red-500/20"
                        >
                            Reconnect
                        </button>
                        <button onClick={clearPersistenceError} className="rounded p-1 hover:bg-red-500/20" aria-label="Dismiss save error">
                            <X size={16} />
                        </button>
                    </div>
                </div>
            )}

            {workspaceIssues.length > 0 && (
                <div className="mx-4 mt-3 flex items-center justify-between gap-3 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-sm text-amber-200" role="alert">
                    <span className="flex items-center gap-2"><AlertTriangle size={16}/>{workspaceIssues.length} duplicate label {workspaceIssues.length === 1 ? "group needs" : "groups need"} attention. Affected blocks are read-only until repaired.</span>
                    <button onClick={() => setIsWorkspaceIssuesOpen(true)} className="shrink-0 rounded px-2 py-1 font-medium hover:bg-amber-400/15">Review</button>
                </div>
            )}

            <div className="flex flex-1 min-h-0 overflow-hidden">
                <div className="flex-1 flex flex-col min-w-0 h-full">
                <div role="tablist" aria-label="Open blocks" className="flex overflow-x-auto border-b border-outline bg-surface shrink-0 hidden-scrollbar items-end h-[42px] px-2 pt-2 gap-1">
                    {openTabs.map(id => {
                        const b = blocks.find(x => x.id === id);
                        if (!b) return null;
                        const isActive = activeTab === id;
                        return (
                            <div 
                                key={id}
                                ref={element => { if (element) tabRefs.current.set(id, element); else tabRefs.current.delete(id); }}
                                role="tab"
                                aria-selected={isActive}
                                aria-controls={`block-tab-panel-${id}`}
                                tabIndex={isActive ? 0 : -1}
                                draggable
                                onDragStart={(e) => handleDragStart(e, id)}
                                onDragOver={handleDragOver}
                                onDrop={(e) => handleDrop(e, id)}
                                onDragEnd={handleDragEnd}
                                onClick={() => activateTab(id)}
                                onKeyDown={(event) => handleTabKeyDown(event, id)}
                                className={`flex items-center gap-2 px-3 py-1.5 rounded-t-lg min-w-[100px] max-w-[200px] cursor-pointer text-sm transition-colors border-t border-x ${isActive ? 'bg-base border-outline z-10 text-primary font-semibold' : 'bg-surface border-transparent text-secondary hover:bg-accent/10 hover:text-primary z-0 border-b-outline'}`}
                                style={isActive ? { borderBottomColor: 'transparent', marginBottom: '-1px' } : { borderBottomWidth: '1px' }}
                            >
                                <span className="truncate flex-1 select-none pointer-events-none">{b.title || b.label}</span>
                                <button 
                                    onClick={(e) => closeTab(id, e)} 
                                    aria-label={`Close ${b.title || b.label}`}
                                    tabIndex={-1}
                                    className="p-1 hover:bg-red-500/20 hover:text-red-500 rounded text-secondary transition-colors"
                                >
                                    <X size={12} />
                                </button>
                            </div>
                        );
                    })}
                </div>

                <div className="relative flex-1 min-h-0 bg-base">
                    {openTabs.map(id => (
                        <div
                            key={id}
                            id={`block-tab-panel-${id}`}
                            role="tabpanel"
                            aria-hidden={activeTab !== id}
                            className={`absolute inset-0 overflow-y-auto p-4 md:p-8 bg-base ${activeTab === id ? 'visible pointer-events-auto' : 'invisible pointer-events-none'}`}
                            onClick={(e) => {
                                const target = e.target;
                                if (target instanceof Element && !target.closest('[data-block-root]')) {
                                    setActiveBlock(null);
                                    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
                                }
                            }}
                        >
                            <div className="max-w-4xl mx-auto pb-64" data-testid="block-workspace-background">
                                <BlockContainer id={id} />
                            </div>
                        </div>
                    ))}
                    {!activeTab && (
                        <div className="absolute inset-0 overflow-y-auto p-4 md:p-8 bg-base">
                          <div className="max-w-4xl mx-auto pb-64">
                            <div className="text-center text-secondary h-full flex flex-col items-center justify-center pt-24">
                                {isLoadingFiles ? (
                                    <>
                                        <Loader2 size={48} className="mb-4 text-accent animate-spin" />
                                        <p className="mb-4">Loading your blocks...</p>
                                    </>
                                ) : backendMode === "none" ? (
                                    <>
                                        <FolderOpen size={48} className="mb-4 opacity-50 text-accent" />
                                        <p className="mb-4">Connect a workspace folder to begin.</p>
                                        <div className="flex flex-col gap-3">
                                            <button 
                                                onClick={() => connectLocalFS()}
                                                disabled={isLoadingFiles}
                                                className="px-4 py-2 bg-accent/20 hover:bg-accent/30 text-accent rounded-lg transition-colors flex items-center gap-2 justify-center disabled:opacity-50"
                                            >
                                                {isLoadingFiles ? <Loader2 size={16} className="animate-spin" /> : <FolderOpen size={16} />} 
                                                Open Workspace
                                            </button>
                                            <button 
                                                onClick={() => fileInputRef.current?.click()}
                                                disabled={isLoadingFiles}
                                                className="px-4 py-2 border border-outline hover:bg-outline rounded-lg transition-colors flex items-center gap-2 justify-center disabled:opacity-50"
                                                title="Read-only viewer (Works on iPad)"
                                            >
                                                {isLoadingFiles ? <Loader2 size={16} className="animate-spin" /> : <FileText size={16} />} 
                                                View Folder (Read-Only)
                                            </button>
                                        </div>
                                    </>
                                ) : (
                                    <>
                                        <Search size={48} className="mb-4 opacity-50 text-accent" />
                                        <p>Search for a block or create a new one to begin.</p>
                                        <button 
                                            onClick={() => setIsSearchModalOpen(true)}
                                            className="mt-4 px-4 py-2 bg-outline/50 hover:bg-outline rounded-lg text-primary transition-colors flex items-center gap-2"
                                        >
                                            <Search size={16} /> Open Search
                                        </button>
                                    </>
                                )}
                            </div>
                          </div>
                        </div>
                    )}
                </div>
            </div>
            {isWorkspaceIssuesOpen && workspaceIssues.length > 0 && <React.Suspense fallback={<ModalLoading label="Loading workspace issues"/>}><WorkspaceIssuesModal onClose={() => setIsWorkspaceIssuesOpen(false)}/></React.Suspense>}
            </div>
            
            {isSearchModalOpen && <React.Suspense fallback={<ModalLoading label="Loading search"/>}><SearchModal isOpen onClose={() => setIsSearchModalOpen(false)} /></React.Suspense>}
            {isGraphModalOpen && (
                <React.Suspense fallback={
                    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center" role="status" aria-label="Loading graph view">
                        <Loader2 size={32} className="animate-spin text-accent" aria-hidden="true" />
                    </div>
                }>
                    <GraphModal isOpen onClose={() => setIsGraphModalOpen(false)} />
                </React.Suspense>
            )}
            {isBlockMapOpen && (
                <React.Suspense fallback={
                    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" role="status" aria-label="Loading blocks view">
                        <Loader2 size={32} className="animate-spin text-accent" aria-hidden="true" />
                    </div>
                }>
                    <BlockMapModal isOpen onClose={() => setIsBlockMapOpen(false)} />
                </React.Suspense>
            )}
            {isMacroModalOpen && <React.Suspense fallback={<ModalLoading label="Loading settings"/>}><SettingsModal isOpen onClose={() => setIsMacroModalOpen(false)} /></React.Suspense>}
            {imageUploadParams && <React.Suspense fallback={<ModalLoading label="Loading image upload"/>}><ImageUploadModal /></React.Suspense>}
        </div>
    );
}

function ModalLoading({ label }: { label: string }) {
    return <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" role="status" aria-label={label}><Loader2 size={32} className="animate-spin text-accent" aria-hidden="true"/></div>;
}
