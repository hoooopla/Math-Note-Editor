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
import { Search, Plus, X, Settings, FolderOpen, Command } from "lucide-react";
import "./index.css";

export default function App() {
    const blocks = useStore(state => state.blocks);
    const backendMode = useStore(state => state.backendMode);
    const { addBlock, setActiveBlock, initBackend, connectLocalFS, openTabs, activeTab, setOpenTabs, setActiveTab, settings } = useStore();
    const [isMacroModalOpen, setIsMacroModalOpen] = useState(false);
    const [isSearchModalOpen, setIsSearchModalOpen] = useState(false);
    
    // Drag state for tabs
    const [draggedTab, setDraggedTab] = useState<string | null>(null);

    useEffect(() => {
        initBackend();
    }, [initBackend]);

    useEffect(() => {
        const validTabs = openTabs.filter(t => blocks.some(b => b.id === t));
        if (validTabs.length !== openTabs.length) {
            setOpenTabs(validTabs);
            if (activeTab && !validTabs.includes(activeTab)) {
                setActiveTab(validTabs.length > 0 ? validTabs[validTabs.length - 1] : null);
            }
        }
    }, [blocks, openTabs, activeTab, setOpenTabs, setActiveTab]);

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
                "--math-color-escaped": settings.mathColors?.escaped || "#56b6c2"
            } as React.CSSProperties}
        >
            <div className="flex h-12 bg-surface border-b border-outline items-center px-4 justify-between shrink-0">
                <div className="flex items-center gap-4">
                    <h1 className="text-[16px] font-bold tracking-tight text-primary flex items-center gap-2">
                        <Command className="text-accent" size={20} /> NoteFlow
                    </h1>
                </div>

                <div className="flex items-center gap-2">
                    {backendMode === "none" && (
                        <button 
                            onClick={() => connectLocalFS()}
                            className="px-3 py-1.5 bg-accent/20 text-accent rounded-lg font-medium text-sm hover:bg-accent/30 transition-colors flex items-center gap-2 mr-2"
                        >
                            <FolderOpen size={16} /> Open Workspace
                        </button>
                    )}
                    <button 
                        onClick={() => setIsSearchModalOpen(true)}
                        className="px-3 py-1.5 text-secondary hover:text-primary hover:bg-outline rounded flex items-center gap-2 text-sm transition-colors border border-transparent hover:border-outline"
                    >
                        <Search size={16} /> Search <kbd className="text-xs font-mono bg-base px-1.5 rounded ml-1 border border-outline shadow-sm">{settings.searchShortcut || 'meta+k'}</kbd>
                    </button>
                    <div className="w-px h-6 bg-outline mx-1"></div>
                    <button 
                        onClick={() => setIsMacroModalOpen(true)}
                        className="p-1.5 hover:bg-accent/20 rounded text-secondary hover:text-accent transition-colors"
                        title="Settings"
                    >
                        <Settings size={18} />
                    </button>
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
                    >
                        <Plus size={18} />
                    </button>
                </div>
            </div>

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
                                {backendMode === "none" ? (
                                    <>
                                        <FolderOpen size={48} className="mb-4 opacity-50 text-accent" />
                                        <p>Connect a workspace folder to begin.</p>
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
            
            <SearchModal isOpen={isSearchModalOpen} onClose={() => setIsSearchModalOpen(false)} />
            <SettingsModal isOpen={isMacroModalOpen} onClose={() => setIsMacroModalOpen(false)} />
            <ImageUploadModal />
        </div>
    );
}
