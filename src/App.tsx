/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect } from "react";
import { useStore } from "./store";
import { useShallow } from 'zustand/react/shallow';
import { BlockContainer } from "./components/Block";
import "./index.css";

export default function App() {
    const blockIds = useStore(useShallow(state => state.blocks.filter(b => !b.label.includes('/')).map(b => b.id)));
    const { activeBlockId, addBlock, setActiveBlock, loadBlocks } = useStore();

    useEffect(() => {
        loadBlocks();
    }, [loadBlocks]);

    useEffect(() => {
        if (!activeBlockId && blockIds.length > 0) {
            const lastBlockId = blockIds[blockIds.length - 1];
            const lastBlock = useStore.getState().blocks.find(b => b.id === lastBlockId);
            if (lastBlock) {
                setActiveBlock(lastBlockId, "end", [lastBlock.label]);
            }
        }
    }, [activeBlockId, blockIds.length, setActiveBlock, blockIds]);

    return (
        <div 
            className="min-h-screen bg-base text-primary p-4 md:p-8 font-sans selection:bg-accent/30 selection:text-white flex flex-col"
            onClick={(e) => {
                if (e.target === e.currentTarget) {
                    setActiveBlock(null);
                }
            }}
        >
            <div className="max-w-5xl mx-auto w-full pt-16 pb-32 flex-1 flex flex-col" onClick={(e) => {
                if (e.target === e.currentTarget) {
                    // Clicking in the empty space below blocks creates a new block
                    addBlock(blockIds.length - 1);
                }
            }}>
                <header className="mb-8" onClick={e => e.stopPropagation()}>
                    <h1 className="text-[16px] font-bold tracking-tight text-primary mb-2">Math Notes</h1>
                    <p className="text-secondary text-[12px]">Block-based editor with live KaTeX rendering.</p>
                </header>

                <div className="space-y-2 w-full" onClick={e => e.stopPropagation()}>
                    {blockIds.map((id, i) => (
                        <BlockContainer 
                            key={id}
                            id={id}
                            index={i}
                        />
                    ))}
                </div>
                
                {/* 1.1 Target spacer for explicit bottom addition */}
                <div 
                    className="flex-1 min-h-[100px] cursor-text"
                    onClick={() => addBlock(blockIds.length - 1)}
                 />
            </div>
        </div>
    );
}
