import React, { useState, useEffect } from "react";
import { useStore } from "../store";
import { CodeMirrorEditor } from "./CodeMirrorEditor";
import type { EditorView } from "@codemirror/view";
import { setEditorFocus } from "../lib/editor/katex-plugin";
import { MathTitle } from "./MathTitle";
import { ExternalLink } from "lucide-react";

export interface EmbeddedBlockUIProps {
    text: string;
    parentLabel: string;
    visitedLabels?: string[];
    toggleOpen: (e?: React.MouseEvent) => void;
    view?: EditorView;
    pos?: number;
    length?: number;
    isAtEndOfLine?: boolean;
    isAtStartOfLine?: boolean;
}

export function EmbeddedBlockUI({ text, parentLabel, visitedLabels = [], toggleOpen, view, pos, length, isAtEndOfLine = false, isAtStartOfLine = false }: EmbeddedBlockUIProps) {
    let displayStyle: "standout" | "inline" = "inline";
    let ifToggled: "open" | "closed" = "closed";
    
    const { activePath, focusDirection, activeFocusPos, loadBlockContent, settings } = useStore();
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
            const hasContent = targetBlock?.content !== undefined ? targetBlock.content.trim().length > 0 : !!targetBlock?.hasContent;
            const filledColor = settings?.standoutBlockTitleColorWithContent || "#a8b5c2";
            const emptyColor = settings?.standoutBlockTitleColorEmpty || "#FF997D";
            const color = hasContent ? filledColor : emptyColor;
            const indentWidth = settings?.standoutBlockIndentWidth ?? 0;
            
            const titlePl = settings?.standoutBlockTitlePaddingLeft ?? 10;
            const titlePr = settings?.standoutBlockTitlePaddingRight ?? 6;
            const titlePt = settings?.standoutBlockTitlePaddingTop ?? 5;
            const titlePb = settings?.standoutBlockTitlePaddingBottom ?? 5;
            const borderColor = settings?.standoutBlockBorderColor || '#ffffff';
            const borderWidth = settings?.standoutBlockBorderWidth ?? 1;
            
            return (
                <div 
                    className={`inline-block align-top rounded-xl ${isAtStartOfLine ? 'mt-0.5' : 'mt-1'} ${isAtEndOfLine ? 'mb-1' : 'mb-2'} cursor-pointer hover:shadow-sm transition-all select-none overflow-visible bg-surface/30 hover:bg-surface/50 group`}
                    style={{ 
                        borderStyle: 'solid',
                        borderWidth: `${borderWidth}px`,
                        borderColor: borderColor,
                        marginLeft: indentWidth > 0 ? `${indentWidth}px` : undefined,
                        width: indentWidth > 0 ? `calc(100% - ${indentWidth}px)` : '100%'
                    }}
                    onMouseDown={e => { e.preventDefault(); e.stopPropagation(); }}
                    onClick={handleClick}
                >
                    <div className="flex items-center justify-between"
                         style={{ 
                             paddingLeft: `${titlePl}px`, 
                             paddingRight: `${titlePr}px`, 
                             paddingTop: `${titlePt}px`, 
                             paddingBottom: `${titlePb}px` 
                         }}>
                        <div className="flex items-center gap-2.5">
                            <div style={{ color }}>
                                <MathTitle text={displayTitle} className="font-semibold" />
                            </div>
                            <span className="text-[11px] font-mono text-secondary/80 bg-background px-1.5 py-0.5 rounded-md border border-outline/50">{fullLabel}</span>
                        </div>
                        <span className="text-secondary/40 group-hover:text-secondary opacity-0 group-hover:opacity-100 transition-opacity mr-1" title="Cmd/Ctrl + Click to open in new tab">
                            <ExternalLink size={14} />
                        </span>
                    </div>
                </div>
            );
        } else {
            const hasContent = targetBlock?.content !== undefined ? targetBlock.content.trim().length > 0 : !!targetBlock?.hasContent;
            const filledColor = settings?.inlineBlockTitleColorWithContent || "#a8b5c2";
            const emptyColor = settings?.inlineBlockTitleColorEmpty || "#FF997D";
            const color = hasContent ? filledColor : emptyColor;
            return (
                <span 
                    className="inline border-b-2 border-dotted cursor-pointer mx-1 select-none font-semibold transition-colors opacity-90 hover:opacity-100"
                    style={{ color, borderColor: color }}
                    onMouseDown={e => { e.preventDefault(); e.stopPropagation(); }}
                    onClick={handleClick}
                >
                    <MathTitle text={displayTitle} />
                </span>
            );
        }
    }

    // if_toggled = open
    const macros = useStore.getState().settings?.macros || {};

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
            let nextPos = pos + length;
            if (isAtEndOfLine) {
                const doc = view.state.doc;
                const currentLine = doc.lineAt(nextPos);
                if (currentLine.number < doc.lines) {
                    nextPos = doc.line(currentLine.number + 1).from;
                }
            }
            view.dispatch({
                selection: { anchor: nextPos },
                effects: setEditorFocus.of(true)
            });
            view.focus();
        }
    };

    if (displayStyle === "standout") {
        const hasContent = targetBlock?.content !== undefined ? targetBlock.content.trim().length > 0 : !!targetBlock?.hasContent;
        const filledColor = settings?.standoutBlockTitleColorWithContent || "#a8b5c2";
        const emptyColor = settings?.standoutBlockTitleColorEmpty || "#FF997D";
        const color = hasContent ? filledColor : emptyColor;
        const indentWidth = settings?.standoutBlockIndentWidth ?? 0;
        
        const titlePl = settings?.standoutBlockTitlePaddingLeft ?? 10;
        const titlePr = settings?.standoutBlockTitlePaddingRight ?? 6;
        const titlePt = settings?.standoutBlockTitlePaddingTop ?? 5;
        const titlePb = settings?.standoutBlockTitlePaddingBottom ?? 5;
        
        const contentPl = settings?.standoutBlockContentPaddingLeft ?? 10;
        const contentPt = settings?.standoutBlockContentPaddingTop ?? 8;
        const contentPr = settings?.standoutBlockContentPaddingRight ?? 12;
        const contentPb = settings?.standoutBlockContentPaddingBottom ?? 12;
        
        const borderColor = settings?.standoutBlockBorderColor || '#ffffff';
        const dividerColor = settings?.standoutBlockDividerColor || '#ffffff';
        const borderWidth = settings?.standoutBlockBorderWidth ?? 1;
        const dividerWidth = settings?.standoutBlockDividerWidth ?? 1;
        
        return (
            <div 
                className={`inline-block align-top rounded-xl ${isAtStartOfLine ? 'mt-0.5' : 'mt-1'} ${isAtEndOfLine ? 'mb-1.5' : 'mb-3'} select-none overflow-visible bg-surface shadow-sm focus-within:ring-1 transition-all`}
                style={{ 
                    borderStyle: 'solid',
                    borderWidth: `${borderWidth}px`,
                    borderColor: borderColor,
                    marginLeft: indentWidth > 0 ? `${indentWidth}px` : undefined,
                    width: indentWidth > 0 ? `calc(100% - ${indentWidth}px)` : '100%',
                    "--tw-ring-color": color + "33", // 33 for 20% opacity using tw ring var
                } as React.CSSProperties}
            >
                <div 
                    className="flex justify-between items-center bg-surface/80 cursor-pointer hover:bg-surface transition-colors group rounded-t-[11px]"
                    style={{ 
                        borderBottom: `${dividerWidth}px solid ${dividerColor}`, 
                        paddingLeft: `${titlePl}px`, 
                        paddingRight: `${titlePr}px`, 
                        paddingTop: `${titlePt}px`, 
                        paddingBottom: `${titlePb}px` 
                    }}
                    onMouseDown={e => { e.preventDefault(); e.stopPropagation(); }}
                    onClick={handleClick}
                >
                    <div className="flex items-center gap-2.5">
                        <div style={{ color }}>
                            <MathTitle text={displayTitle} className="font-semibold" />
                        </div>
                    </div>
                    <div className="flex items-center gap-3">
                        <span className="text-[11px] font-mono text-secondary/80 bg-background px-1.5 py-0.5 rounded-md border border-outline/50">{fullLabel}</span>
                        <span className="text-secondary/40 hover:text-secondary transition-colors" title="Cmd/Ctrl + Click to open in new tab"
                              onClick={(e) => {
                                  e.stopPropagation();
                                  useStore.getState().openBlockInTab(targetBlock!.id, true);
                              }}
                        >
                            <ExternalLink size={14} />
                        </span>
                    </div>
                </div>
                <div className="bg-background/50 rounded-b-xl font-sans text-primary relative overflow-visible" 
                     style={{ 
                         paddingLeft: `${contentPl}px`, 
                         paddingRight: `${contentPr}px`, 
                         paddingTop: `${contentPt}px`, 
                         paddingBottom: `${contentPb}px` 
                     }}
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
                        onImagePaste={(file, insertContent) => useStore.getState().setImageUploadParams({ file, onInsert: insertContent })}
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
        const filledColor = settings?.inlineBlockTitleColorWithContent || "#a8b5c2";
        const emptyColor = settings?.inlineBlockTitleColorEmpty || "#FF997D";
        const color = hasContent ? filledColor : emptyColor;
        const indentWidth = settings?.inlineBlockIndentWidth ?? 16;
        return (
            <span className="inline align-top">
                <span 
                    className="inline border-b-2 border-dotted cursor-pointer mx-1 select-none font-semibold transition-colors opacity-90 hover:opacity-100"
                    style={{ color, borderColor: color }}
                    onMouseDown={e => { e.preventDefault(); e.stopPropagation(); }}
                    onClick={handleClick}
                    title={`Close ${displayTitle}`}
                >
                    <MathTitle text={displayTitle} />
                </span>
                <span className={`inline-block w-full py-2 border-l-2 border-accent/30 select-text bg-surface/30 rounded-r-lg relative overflow-visible mt-1 mb-1`} 
                     style={{ paddingLeft: `${indentWidth}px` }}
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
                        onImagePaste={(file, insertContent) => useStore.getState().setImageUploadParams({ file, onInsert: insertContent })}
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
