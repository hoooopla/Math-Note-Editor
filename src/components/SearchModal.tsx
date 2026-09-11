import React, { useState, useEffect, useRef, useMemo } from 'react';
import { getOrderedBlocks, useStore } from '../store';
import { Search, FolderOpen, Plus } from 'lucide-react';
import { MathTitle } from './MathTitle';
import { useVirtualizer } from '@tanstack/react-virtual';
import { normalizeBlockLabel, normalizeBlockTitle, validateBlockMetadata } from '../lib/label-policy';

export function SearchModal({ isOpen, onClose }: { isOpen: boolean, onClose: () => void }) {
    const blocksRevision = useStore(state => state.blocksRevision);
    const blocks = useMemo(() => getOrderedBlocks(useStore.getState()), [blocksRevision]);
    const addBlock = useStore(state => state.addBlock);
    const activateRootBlock = useStore(state => state.activateRootBlock);
    const settings = useStore(state => state.settings);
    const backendMode = useStore(state => state.backendMode);
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [creationError, setCreationError] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const parentRef = useRef<HTMLDivElement>(null);

    const searchResults = useMemo(() => {
        if (!searchQuery) {
            return blocks;
        }
        const lower = searchQuery.toLowerCase();
        return blocks.filter(b => 
             b.title.toLowerCase().includes(lower) || 
             b.label.toLowerCase().includes(lower)
        );
    }, [blocks, searchQuery]);

    const createTitle = normalizeBlockTitle(searchQuery);
    const createLabel = normalizeBlockLabel(searchQuery);
    const createValidationError = searchQuery ? validateBlockMetadata(createTitle, createLabel) : null;

    const rowVirtualizer = useVirtualizer({
        count: searchResults.length,
        getScrollElement: () => parentRef.current,
        estimateSize: () => 56, // approx height of each row
        overscan: 5,
    });

    useEffect(() => {
        if (isOpen) {
            setSearchQuery('');
            setSelectedIndex(0);
            setCreationError(null);
            setTimeout(() => inputRef.current?.focus(), 50);
        }
    }, [isOpen]);

    useEffect(() => {
        setSelectedIndex(0);
        setCreationError(null);
    }, [searchQuery]);

    useEffect(() => {
        if (searchResults.length > 0) {
            rowVirtualizer.scrollToIndex(selectedIndex, { align: 'auto' });
        }
    }, [selectedIndex, rowVirtualizer, searchResults.length]);

    const handleSelect = async (id?: string) => {
        if (id) {
            activateRootBlock(id);
            onClose();
        } else if (searchQuery && backendMode !== 'viewer') {
            if (createValidationError) {
                setCreationError(createValidationError);
                return;
            }
            const newBlock = await addBlock({ title: createTitle, label: createLabel });
            if (newBlock) {
                activateRootBlock(newBlock.id, 'start');
                onClose();
            } else {
                setCreationError(useStore.getState().persistenceError || 'Block could not be created');
            }
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSelectedIndex(prev => Math.min(prev + 1, searchResults.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSelectedIndex(prev => Math.max(prev - 1, 0));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (searchResults[selectedIndex]) {
                handleSelect(searchResults[selectedIndex].id);
            } else if (searchQuery && backendMode !== 'viewer') {
                handleSelect();
            }
        } else if (e.key === 'Escape') {
            onClose();
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/50 flex justify-center items-start pt-[20vh] z-[200] p-4" onClick={onClose}>
            <div 
                className="bg-surface border border-outline rounded-xl shadow-2xl w-full max-w-xl overflow-hidden flex flex-col" 
                onClick={e => e.stopPropagation()}
            >
                <div className="p-3 border-b border-outline flex items-center gap-3 relative">
                    <Search className="text-secondary" size={20} />
                    <input 
                        ref={inputRef}
                        type="text"
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Search blocks or create new..."
                        className="w-full bg-transparent border-none text-primary text-lg focus:outline-none"
                    />
                </div>
                <div 
                    ref={parentRef}
                    className="max-h-[50vh] overflow-y-auto w-full p-2"
                >
                    {searchResults.length > 0 ? (
                        <div
                            style={{
                                height: `${rowVirtualizer.getTotalSize()}px`,
                                width: '100%',
                                position: 'relative',
                            }}
                        >
                            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                                const b = searchResults[virtualRow.index];
                                const i = virtualRow.index;
                                return (
                                    <div
                                        key={virtualRow.key}
                                        style={{
                                            position: 'absolute',
                                            top: 0,
                                            left: 0,
                                            width: '100%',
                                            height: `${virtualRow.size - 4}px`,
                                            transform: `translateY(${virtualRow.start}px)`,
                                        }}
                                        onClick={() => handleSelect(b.id)}
                                        className={`px-3 py-2 cursor-pointer rounded flex flex-col ${i === selectedIndex ? 'bg-accent/20 text-accent' : 'hover:bg-outline/50'}`}
                                    >
                                        <MathTitle text={b.title || b.label || 'Untitled'} className="font-semibold" />
                                        <span className={`text-[11px] truncate ${i === selectedIndex ? 'text-accent/70' : 'text-secondary'}`}>{b.label}</span>
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        searchQuery && backendMode !== 'viewer' && !createValidationError && !creationError ? (
                            <div 
                                onClick={() => handleSelect()}
                                className="px-3 py-3 cursor-pointer rounded bg-accent/20 text-accent flex flex-col items-center justify-center text-center"
                            >
                                <span className="font-semibold flex items-center gap-2"><Plus size={16} /> Create "{searchQuery}"</span>
                            </div>
                        ) : (
                            <div className={`p-4 text-center text-sm ${createValidationError || creationError ? 'text-red-400' : 'text-secondary'}`} role={createValidationError || creationError ? 'alert' : undefined}>
                                {creationError || createValidationError || 'No blocks found'}
                            </div>
                        )
                    )}
                </div>
                <div className="p-2 border-t border-outline flex justify-between items-center text-xs text-secondary bg-base/50">
                    <div className="flex gap-4">
                        <span><kbd className="font-mono bg-outline/50 px-1 rounded">↑</kbd> <kbd className="font-mono bg-outline/50 px-1 rounded">↓</kbd> to navigate</span>
                        <span><kbd className="font-mono bg-outline/50 px-1 rounded">Enter</kbd> to select</span>
                        <span><kbd className="font-mono bg-outline/50 px-1 rounded">Esc</kbd> to close</span>
                    </div>
                </div>
            </div>
        </div>
    );
}
