/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo, useRef } from "react";
import { useStore } from "./store";
import { BlockContainer } from "./components/Block";
import { SettingsModal } from "./components/SettingsModal";
import { ImageUploadModal } from "./components/ImageUploadModal";
import { SearchModal } from "./components/SearchModal";
import { GraphModal } from "./components/GraphModal";
import { Search, Plus, X, Settings, FolderOpen, Command, FileText, Loader2, Network, FlaskConical } from "lucide-react";
import "./index.css";

export default function App() {
    const fileInputRef = React.useRef<HTMLInputElement>(null);
    const loadViewerFiles = useStore(state => state.loadViewerFiles);
    const blocks = useStore(state => state.blocks);
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
    const settings = useStore(state => state.settings);
    const persistenceError = useStore(state => state.persistenceError);
    const clearPersistenceError = useStore(state => state.clearPersistenceError);
    const flushBlock = useStore(state => state.flushBlock);
    const flushPendingSaves = useStore(state => state.flushPendingSaves);
    const [isMacroModalOpen, setIsMacroModalOpen] = useState(false);
    const [isSearchModalOpen, setIsSearchModalOpen] = useState(false);
    const [isGraphModalOpen, setIsGraphModalOpen] = useState(false);
    const [isTestMode, setIsTestMode] = useState(false);
    
    // Drag state for tabs
    const [draggedTab, setDraggedTab] = useState<string | null>(null);

    useEffect(() => {
        initBackend();
    }, [initBackend]);

    useEffect(() => {
        fetch('/api/runtime')
            .then(response => response.ok ? response.json() : null)
            .then(runtime => setIsTestMode(runtime?.testMode === true))
            .catch(() => setIsTestMode(false));
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
                setActiveTab(validTabs.length > 0 ? validTabs[validTabs.length - 1] : null);
            }
        }
    }, [isLoaded, blocks, openTabs, activeTab, setOpenTabs, setActiveTab]);

    useEffect(() => {
        if (openTabs.length === 0 && blocks.length > 0) {
            const welcome = blocks.find(b => b.label === "showcase:main");
            const first = welcome || blocks[0];
            if (first) {
                setOpenTabs([first.id]);
                setActiveTab(first.id);
            }
        }
    }, [blocks, openTabs.length, setOpenTabs, setActiveTab]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            const shortcut = settings.searchShortcut || 'meta+k';
            const parts = shortcut.toLowerCase().split('+');
            const requiresCtrl = parts.includes('ctrl');
            const requiresMeta = parts.includes('cmd') || parts.includes('meta');
            const key = parts[parts.length - 1];

            const matchesModifiers = (requiresCtrl ? e.ctrlKey : true) && (requiresMeta ? e.metaKey : true);
            
            if (matchesModifiers && e.key.toLowerCase() === key) {
                e.preventDefault();
                setIsSearchModalOpen(true);
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [settings.searchShortcut]);

    const closeTab = (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        void flushBlock(id);
        const newTabs = openTabs.filter(t => t !== id);
        setOpenTabs(newTabs);
        if (activeTab === id) {
            setActiveTab(newTabs.length > 0 ? newTabs[newTabs.length - 1] : null);
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
                                    setOpenTabs([...openTabs, newBlock.id]);
                                    setActiveTab(newBlock.id);
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
                    <button onClick={clearPersistenceError} className="shrink-0 rounded p-1 hover:bg-red-500/20" aria-label="Dismiss save error">
                        <X size={16} />
                    </button>
                </div>
            )}

            <div className="flex flex-1 min-h-0 overflow-hidden">
                <div className="flex-1 flex flex-col min-w-0 h-full">
                <div className="flex overflow-x-auto border-b border-outline bg-surface shrink-0 hidden-scrollbar items-end h-[42px] px-2 pt-2 gap-1">
                    {openTabs.map(id => {
                        const b = blocks.find(x => x.id === id);
                        if (!b) return null;
                        const isActive = activeTab === id;
                        return (
                            <div 
                                key={id}
                                draggable
                                onDragStart={(e) => handleDragStart(e, id)}
                                onDragOver={handleDragOver}
                                onDrop={(e) => handleDrop(e, id)}
                                onDragEnd={handleDragEnd}
                                onClick={() => setActiveTab(id)}
                                className={`flex items-center gap-2 px-3 py-1.5 rounded-t-lg min-w-[100px] max-w-[200px] cursor-pointer text-sm transition-colors border-t border-x ${isActive ? 'bg-base border-outline z-10 text-primary font-semibold' : 'bg-surface border-transparent text-secondary hover:bg-accent/10 hover:text-primary z-0 border-b-outline'}`}
                                style={isActive ? { borderBottomColor: 'transparent', marginBottom: '-1px' } : { borderBottomWidth: '1px' }}
                            >
                                <span className="truncate flex-1 select-none pointer-events-none">{b.title || b.label}</span>
                                <button 
                                    onClick={(e) => closeTab(id, e)} 
                                    className="p-1 hover:bg-red-500/20 hover:text-red-500 rounded text-secondary transition-colors"
                                >
                                    <X size={12} />
                                </button>
                            </div>
                        );
                    })}
                </div>

                <div 
                    className="flex-1 overflow-y-auto p-4 md:p-8 bg-base"
                    onClick={(e) => {
                        if (e.target === e.currentTarget) {
                            setActiveBlock(null);
                        }
                    }}
                >
                    <div className="max-w-4xl mx-auto pb-64">
                        {activeTab ? (
                            <BlockContainer key={activeTab} id={activeTab} index={0} />
                        ) : (
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
                        )}
                    </div>
                </div>
            </div>
            </div>
            
            <SearchModal isOpen={isSearchModalOpen} onClose={() => setIsSearchModalOpen(false)} />
            <GraphModal isOpen={isGraphModalOpen} onClose={() => setIsGraphModalOpen(false)} />
            <SettingsModal isOpen={isMacroModalOpen} onClose={() => setIsMacroModalOpen(false)} />
            <ImageUploadModal />
        </div>
    );
}
