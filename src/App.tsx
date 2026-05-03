/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from "react";
import { useStore } from "./store";
import { BlockContainer } from "./components/Block";
import { Search, Plus, X } from "lucide-react";
import "./index.css";

export default function App() {
    const blocks = useStore(state => state.blocks);
    const { addBlock, setActiveBlock, loadBlocks, openTabs, activeTab, setOpenTabs, setActiveTab } = useStore();
    const [searchQuery, setSearchQuery] = useState("");

    useEffect(() => {
        loadBlocks();
    }, [loadBlocks]);

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

    const handleSearchClick = (id: string) => {
        if (!openTabs.includes(id)) {
            setOpenTabs([...openTabs, id]);
        }
        setActiveTab(id);
        setSearchQuery("");
    };

    const searchResults = useMemo(() => {
        if (!searchQuery) return [];
        const lower = searchQuery.toLowerCase();
        return blocks.filter(b => 
            b.title.toLowerCase().includes(lower) || 
            b.label.toLowerCase().includes(lower)
        ).slice(0, 100);
    }, [blocks, searchQuery]);

    const closeTab = (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        const newTabs = openTabs.filter(t => t !== id);
        setOpenTabs(newTabs);
        if (activeTab === id) {
            setActiveTab(newTabs.length > 0 ? newTabs[newTabs.length - 1] : null);
        }
    };

    return (
        <div className="min-h-screen bg-base text-primary font-sans flex flex-col md:flex-row h-screen overflow-hidden selection:bg-accent/30 selection:text-white">
            <div className="w-full md:w-64 bg-surface border-r border-outline flex flex-col h-[30vh] md:h-full shrink-0">
                <div className="p-4 border-b border-outline flex items-center justify-between">
                    <h1 className="text-[16px] font-bold tracking-tight text-primary">Math Notes</h1>
                    <button 
                        onClick={async () => {
                            const newBlock = await addBlock();
                            if (newBlock) {
                                setOpenTabs([...openTabs, newBlock.id]);
                                setActiveTab(newBlock.id);
                            }
                        }}
                        className="p-1 hover:bg-accent/20 rounded text-accent transition-colors"
                        title="New Block"
                    >
                        <Plus size={18} />
                    </button>
                </div>
                <div className="p-4 border-b border-outline relative">
                    <Search size={16} className="absolute left-6 top-6 text-secondary" />
                    <input 
                        type="text"
                        placeholder="Search blocks..."
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                        className="w-full bg-base border border-outline rounded py-2 pl-8 pr-4 text-sm focus:outline-none focus:border-accent"
                    />
                </div>
                <div className="flex-1 overflow-y-auto p-2">
                    {searchQuery ? (
                        <div className="space-y-1">
                            {searchResults.map(b => (
                                <div 
                                    key={b.id} 
                                    onClick={() => handleSearchClick(b.id)}
                                    className="px-3 py-2 cursor-pointer hover:bg-accent/10 rounded flex flex-col"
                                >
                                    <span className="font-semibold text-sm truncate">{b.title}</span>
                                    <span className="text-[10px] text-secondary tracking-wider truncate">{b.label}</span>
                                </div>
                            ))}
                            {searchResults.length === 0 && <div className="p-3 text-secondary text-sm">No results found.</div>}
                        </div>
                    ) : (
                        <div className="space-y-1">
                            <div className="px-3 py-2 text-xs font-semibold text-secondary tracking-wider">Recent Blocks</div>
                            {blocks.slice(0, 50).map(b => (
                                <div 
                                    key={b.id} 
                                    onClick={() => handleSearchClick(b.id)}
                                    className="px-3 py-2 cursor-pointer hover:bg-accent/10 rounded flex flex-col"
                                >
                                    <span className="font-semibold text-sm truncate">{b.title}</span>
                                    <span className="text-[10px] text-secondary tracking-wider truncate">{b.label}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            <div className="flex-1 flex flex-col min-w-0 h-[70vh] md:h-full">
                <div className="flex overflow-x-auto border-b border-outline bg-surface shrink-0 hidden-scrollbar items-end h-[42px] px-2 pt-2 gap-1">
                    {openTabs.map(id => {
                        const b = blocks.find(x => x.id === id);
                        if (!b) return null;
                        const isActive = activeTab === id;
                        return (
                            <div 
                                key={id}
                                onClick={() => setActiveTab(id)}
                                className={`flex items-center gap-2 px-3 py-1.5 rounded-t-lg min-w-[100px] max-w-[200px] cursor-pointer text-sm transition-colors border-t border-x ${isActive ? 'bg-base border-outline z-10 text-primary font-semibold' : 'bg-surface border-transparent text-secondary hover:bg-accent/10 hover:text-primary z-0 border-b-outline'}`}
                                style={isActive ? { borderBottomColor: 'transparent', marginBottom: '-1px' } : { borderBottomWidth: '1px' }}
                            >
                                <span className="truncate flex-1 select-none">{b.title || b.label}</span>
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
                                <Search size={48} className="mb-4 opacity-50 text-accent" />
                                <p>Search for a block or create a new one to begin.</p>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
