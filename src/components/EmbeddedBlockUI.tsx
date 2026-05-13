import React, { useState, useEffect } from "react";
import { useStore } from "../store";
import { CodeMirrorEditor } from "./CodeMirrorEditor";
import type { EditorView } from "@codemirror/view";
import { setEditorFocus } from "../lib/editor/katex-plugin";

export interface EmbeddedBlockUIProps {
    text: string;
    parentLabel: string;
    visitedLabels?: string[];
    toggleOpen: (e?: React.MouseEvent) => void;
    view?: EditorView;
    pos?: number;
    length?: number;
}

export function EmbeddedBlockUI({ text, parentLabel, visitedLabels = [], toggleOpen, view, pos, length }: EmbeddedBlockUIProps) {
    let displayStyle: "standout" | "inline" = "inline";
    let ifToggled: "open" | "closed" = "closed";
    
    const { activePath, focusDirection, activeFocusPos, loadBlockContent } = useStore();
    const [isLocalFocused, setIsLocalFocused] = useState(false);

    let rawText = text;
    if (rawText.startsWith("@")) {
        displayStyle = "standout";
        rawText = rawText.slice(1);
    }
    if (rawText.endsWith("∨")) {
        ifToggled = "open";
        rawText = rawText.slice(0, -1);
    }

    let rawLabel = rawText;
    let displayTitle: string | null = null;
    const pipeIdx = rawText.indexOf("||");
    if (pipeIdx !== -1) {
        rawLabel = rawText.slice(0, pipeIdx).trim();
        displayTitle = rawText.slice(pipeIdx + 2).trim();
    } else {
        rawLabel = rawLabel.trim();
    }

    let fullLabel = rawLabel;
    if (rawLabel.startsWith("/")) {
        fullLabel = parentLabel + rawLabel;
    }

    const blocks = useStore(state => state.blocks);
    const targetBlock = blocks.find(b => b.label === fullLabel);
    const isLabelExisted = !!targetBlock;

    useEffect(() => {
        if (targetBlock && targetBlock.content === undefined && ifToggled === "open") {
            loadBlockContent(targetBlock.id);
        }
    }, [targetBlock, ifToggled, loadBlockContent]);

    if (visitedLabels.includes(fullLabel)) {
        return (
            <span className="text-red-400 bg-red-400/10 px-2 py-0.5 rounded mx-1 inline-flex items-center gap-1 border border-red-500/30" title="Circular embedding detected">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-repeat"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>
                <span className="font-semibold text-sm">{fullLabel}</span>
            </span>
        );
    }

    const instancePath = [...visitedLabels, fullLabel];
    const pathMatches = activePath && activePath.length === instancePath.length && activePath.every((l, i) => l === instancePath[i]);

    // We can say it's focused if local focus is true OR activePath precisely matches this instance AND activeFocusPos matches pos (or is null)
    const activeIsMe = pathMatches && (activeFocusPos === null || activeFocusPos === pos);
    const isFocused = isLocalFocused || (activeIsMe ?? false);
    const globalFocusDirection = activeIsMe ? focusDirection : null;

    if (isLabelExisted && displayTitle === null) {
        displayTitle = targetBlock!.title;
    }

    if (!isLabelExisted) {
        return (
            <span className="text-red-400 bg-red-400/10 px-1 rounded mx-1">
                [[{text}]]
            </span>
        );
    }

    const handleClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (e.metaKey || e.ctrlKey) {
            useStore.getState().openBlockInTab(targetBlock!.id, true);
        } else {
            toggleOpen(e);
        }
    };

    // if_toggled = closed
    if (ifToggled === "closed") {
        if (displayStyle === "standout") {
            return (
                <div 
                    className="block w-full border border-outline rounded-lg my-2 px-3 py-2 cursor-pointer hover:border-accent transition-colors select-none"
                    onClick={handleClick}
                >
                    <div className="flex items-center gap-2">
                        <span className="text-accent">▶</span>
                        <span className="font-bold text-primary">{displayTitle}</span>
                        <span className="text-xs text-secondary bg-surface px-1 rounded">{fullLabel}</span>
                    </div>
                </div>
            );
        } else {
            const hasContent = targetBlock?.content !== undefined ? targetBlock.content.trim().length > 0 : !!targetBlock?.hasContent;
            const colorClass = hasContent ? "text-secondary hover:text-primary border-secondary" : "text-[#FF997D] hover:text-[#ffab94] border-[#FF997D]";
            return (
                <span 
                    className={`inline border-b-2 border-dotted cursor-pointer mx-1 select-none font-semibold transition-colors ${colorClass}`}
                    onClick={handleClick}
                >
                    {displayTitle}
                </span>
            );
        }
    }

    // if_toggled = open
    const macros = useStore.getState().macros;

    const handleUp = () => {
        if (view && pos !== undefined) {
            view.dispatch({
                selection: { anchor: pos },
                effects: setEditorFocus.of(true)
            });
            view.focus();
        }
    };
    
    const handleDown = () => {
        if (view && pos !== undefined && length !== undefined) {
            view.dispatch({
                selection: { anchor: pos + length },
                effects: setEditorFocus.of(true)
            });
            view.focus();
        }
    };

    if (displayStyle === "standout") {
        return (
            <div className="block w-full border border-outline rounded-lg my-3 select-none">
                <div 
                    className="flex justify-between items-center px-3 py-2 border-b border-outline bg-surface rounded-t-lg cursor-pointer hover:bg-accent/10 transition-colors"
                    onClick={handleClick}
                >
                    <div className="flex items-center gap-2">
                        <span className="text-accent transform rotate-90">▶</span>
                        <span className="font-bold text-primary">{displayTitle}</span>
                    </div>
                    <span className="text-xs text-secondary px-1 rounded border border-outline">{fullLabel}</span>
                </div>
                <div className="p-3 bg-surface/50 rounded-b-lg font-sans text-primary relative z-50 overflow-visible" 
                     onClick={e => {
                         // Prevents clicking inside widget from blurring the view/widget inappropriately?
                         // e.stopPropagation() is already somewhat implicit for embedded elements, but let's be safe.
                         e.stopPropagation();
                     }}
                >
                    <CodeMirrorEditor 
                        content={targetBlock!.content !== undefined ? targetBlock!.content : ""}
                        onBlur={(val) => {
                            useStore.getState().updateBlock(targetBlock!.id, { content: val });
                            setIsLocalFocused(false);
                        }}
                        onChange={(val) => {
                            useStore.getState().updateBlock(targetBlock!.id, { content: val });
                        }}
                        onUp={handleUp}
                        onDown={handleDown}
                        isFocused={isFocused}
                        macros={macros}
                        focusDirection={globalFocusDirection}
                        parentLabel={fullLabel}
                        visitedLabels={[...visitedLabels, fullLabel]}
                        onEsc={() => toggleOpen()}
                        onFocus={() => {
                            setIsLocalFocused(true);
                            useStore.getState().setActiveBlock(targetBlock!.id, null, [...visitedLabels, fullLabel], pos);
                        }}
                    />
                </div>
            </div>
        );
    } else {
        const hasContent = targetBlock?.content !== undefined ? targetBlock.content.trim().length > 0 : !!targetBlock?.hasContent;
        const colorClass = hasContent ? "text-secondary hover:text-primary border-secondary" : "text-[#FF997D] hover:text-[#ffab94] border-[#FF997D]";
        return (
            <span className="inline align-top">
                <span 
                    className={`inline border-b-2 border-dotted cursor-pointer mx-1 select-none font-semibold transition-colors ${colorClass}`}
                    onClick={handleClick}
                    title={`Close ${displayTitle}`}
                >
                    {displayTitle}
                </span>
                <span className="block w-full pl-4 py-2 border-l-2 border-accent/30 my-2 select-text bg-surface/30 rounded-r-lg relative z-50 overflow-visible" 
                     onClick={e => e.stopPropagation()}>
                    <CodeMirrorEditor 
                        content={targetBlock!.content !== undefined ? targetBlock!.content : ""}
                        onBlur={(val) => {
                            useStore.getState().updateBlock(targetBlock!.id, { content: val });
                            setIsLocalFocused(false);
                        }}
                        onChange={(val) => {
                            useStore.getState().updateBlock(targetBlock!.id, { content: val });
                        }}
                        onUp={handleUp}
                        onDown={handleDown}
                        isFocused={isFocused}
                        macros={macros}
                        focusDirection={globalFocusDirection}
                        parentLabel={fullLabel}
                        visitedLabels={[...visitedLabels, fullLabel]}
                        onEsc={() => toggleOpen()}
                        onFocus={() => {
                            setIsLocalFocused(true);
                            useStore.getState().setActiveBlock(targetBlock!.id, null, [...visitedLabels, fullLabel], pos);
                        }}
                    />
                </span>
            </span>
        );
    }
}
