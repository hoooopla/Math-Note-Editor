import React, { useState, useEffect, useRef } from "react";
import { useStore } from "../store";
import { CodeMirrorEditor } from "./CodeMirrorEditor";
import type { EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import { setEditorFocus } from "../lib/editor/katex-plugin";
import { setEmbeddedObjectSelection } from "../lib/editor/embedded-object-selection";
import { MathTitle } from "./MathTitle";
import { ExternalLink, ChevronRight, ChevronDown } from "lucide-react";
import { parseEmbeddedText, resolveEmbeddedLabel } from "../lib/embedded-link-syntax";
import { handOffEditorBoundary } from "../lib/editor/editor-boundary-registry";
import { startCompletion } from "@codemirror/autocomplete";
import { findActiveEmbeddedTarget } from "../lib/embedded-link-syntax";

export interface EmbeddedBlockUIProps {
    text: string;
    parentLabel: string;
    visitedLabels?: string[];
    toggleOpen: (e?: React.MouseEvent) => void;
    view?: EditorView;
    stateRef?: { pos: number, length: number };
    
    isAtEndOfLine?: boolean;
    isAtStartOfLine?: boolean;
    isKeyboardSelected?: boolean;
}

export function EmbeddedBlockUI({ text, parentLabel, visitedLabels = [], toggleOpen, view, stateRef, isAtEndOfLine = false, isAtStartOfLine = false, isKeyboardSelected = false }: EmbeddedBlockUIProps) {
    const pos = stateRef?.pos;
    const length = stateRef?.length;
    const parsedEmbed = parseEmbeddedText(text);
    const displayStyle: "standout" | "inline" = parsedEmbed.standout ? "standout" : "inline";
    const ifToggled: "open" | "closed" = parsedEmbed.open ? "open" : "closed";
    const keyboardSelectionStyle: React.CSSProperties = isKeyboardSelected ? {
        outline: "1px dotted rgba(96, 165, 250, 0.92)",
        outlineOffset: "1px",
        borderRadius: 0
    } : {};
    
        const activePath = useStore(state => state.activePath);
    const focusDirection = useStore(state => state.focusDirection);
    const activeFocusPos = useStore(state => state.activeFocusPos);
    const activeFocusX = useStore(state => state.activeFocusX);
    const loadBlockContent = useStore(state => state.loadBlockContent);
    const settings = useStore(state => state.settings);

    let displayTitle: string | null = parsedEmbed.alias;
    const fullLabel = resolveEmbeddedLabel(parsedEmbed, parentLabel);

    const targetBlockId = useStore(state => state.blockIdByLabel[fullLabel]);
    const targetBlock = useStore(state => targetBlockId ? state.blocksById[targetBlockId] : undefined);
    const isLabelExisted = !!targetBlock;
    
    const backendMode = useStore(state => state.backendMode);
    const rootBlockId = useStore(state => state.blockIdByLabel[visitedLabels[0]]);
    const rootBlock = useStore(state => rootBlockId ? state.blocksById[rootBlockId] : undefined);
    const viewOnlyBlocks = useStore(state => state.viewOnlyBlocks);
    
    const targetViewOnly = targetBlock ? (viewOnlyBlocks[targetBlock.id] ?? (backendMode === "viewer")) : false;
    const rootViewOnly = rootBlock ? (viewOnlyBlocks[rootBlock.id] ?? (backendMode === "viewer")) : false;
    const isReadOnly = targetViewOnly || rootViewOnly || !!view?.state.readOnly;

    const instancePath = [...visitedLabels, fullLabel];
    const pathMatches = activePath && activePath.length === instancePath.length && activePath.every((l, i) => l === instancePath[i]);
    const activeIsMe = pathMatches && (activeFocusPos === null || activeFocusPos === pos);
    const isFocused = activeIsMe ?? false;
    const globalFocusDirection = activeIsMe ? focusDirection : null;
    const editorHostRef = useRef<HTMLDivElement>(null);
    const titleNavigationRef = useRef<HTMLElement>(null);
    const bodyNavigationRef = useRef<HTMLElement>(null);
    const [editorActivated, setEditorActivated] = useState(false);

    useEffect(() => {
        if (ifToggled === "closed") {
            setEditorActivated(false);
        } else if (isFocused) {
            // Keyboard navigation must be able to focus the destination editor
            // even before its viewport observer runs.
            setEditorActivated(true);
        }
    }, [ifToggled, isFocused]);

    useEffect(() => {
        if (ifToggled !== "open" || editorActivated) return;
        const host = editorHostRef.current;
        if (typeof IntersectionObserver === "undefined") {
            setEditorActivated(true);
            return;
        }
        if (!host) return;

        const observer = new IntersectionObserver(entries => {
            if (entries.some(entry => entry.isIntersecting)) {
                setEditorActivated(true);
                observer.disconnect();
            }
        }, { rootMargin: "600px 0px" });
        observer.observe(host);
        return () => observer.disconnect();
    }, [ifToggled, editorActivated]);

    useEffect(() => {
        if (targetBlock && targetBlock.content === undefined && ifToggled === "open" && editorActivated) {
            loadBlockContent(targetBlock.id);
        }
    }, [targetBlock, ifToggled, editorActivated, loadBlockContent]);

    if (visitedLabels.includes(fullLabel)) {
        return (
            <span className="text-red-400 bg-red-400/10 px-2 py-0.5 rounded mx-1 inline-flex items-center gap-1 border border-red-500/30" title="Circular embedding detected">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-repeat"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>
                <span className="font-semibold text-sm">{fullLabel}</span>
            </span>
        );
    }

    if (isLabelExisted && displayTitle === null) {
        displayTitle = targetBlock!.title;
    }

    if (!isLabelExisted) {
        const handleMissingClick = (event: React.MouseEvent) => {
            event.preventDefault();
            event.stopPropagation();
            if (!view || pos === undefined || length === undefined || isReadOnly) return;
            const target = findActiveEmbeddedTarget(view.state.doc.toString(), Math.max(pos + 2, pos + length - 2));
            if (!target) return;
            view.focus();
            view.dispatch({
                selection: EditorSelection.cursor(target.to),
                effects: setEditorFocus.of(true),
                scrollIntoView: true
            });
            startCompletion(view);
        };
        return (
            <span
                className="text-red-400 bg-red-400/10 px-1 rounded mx-1 cursor-text"
                onMouseDown={event => { event.preventDefault(); event.stopPropagation(); }}
                onClick={handleMissingClick}
            >
                [[{text}]]
            </span>
        );
    }

    const handleClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (e.metaKey || e.ctrlKey) {
            useStore.getState().openBlockInTab(targetBlock!.id, true);
        } else {
            useStore.getState().setActiveBlock(null);
            view?.contentDOM.blur();
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
            
            const level = visitedLabels.length + 1;
            const baseSize = settings?.standoutBlockTitleFontSizeBase ?? 24;
            const step = settings?.standoutBlockTitleFontSizeStep ?? 2;
            const minSize = settings?.standoutBlockTitleFontSizeMin ?? 18;
            const fontSize = Math.max(minSize, baseSize - (level - 1) * step);
            const lightenStep = settings?.standoutBlockBgLightenStep ?? 2;
            const bgLighten = level * lightenStep;
            const bgOpacityClosed = settings?.standoutBlockBgOpacityClosed ?? 30;
            const bgOpacityClosedHover = settings?.standoutBlockBgOpacityClosedHover ?? 40;
            
            return (
                <div 
                    className={`inline-block align-top rounded-xl ${isAtStartOfLine ? 'mt-0.5' : 'mt-1'} ${isAtEndOfLine ? 'mb-1' : 'mb-2'} cursor-pointer hover:shadow-sm transition-all select-none overflow-visible bg-[var(--standout-bg)] hover:bg-[var(--standout-bg-hover)] group/embed`}
                    style={{ 
                        marginLeft: indentWidth > 0 ? `${indentWidth}px` : undefined,
                        width: indentWidth > 0 ? `calc(100% - ${indentWidth}px)` : '100%',
                        "--standout-bg": `color-mix(in srgb, color-mix(in srgb, var(--color-surface), white ${bgLighten}%) ${bgOpacityClosed}%, transparent)`,
                        "--standout-bg-hover": `color-mix(in srgb, color-mix(in srgb, var(--color-surface), white ${bgLighten}%) ${bgOpacityClosedHover}%, transparent)`
                    } as React.CSSProperties}
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
                            <div
                                ref={titleNavigationRef as React.RefObject<HTMLDivElement>}
                                data-embed-nav-title="true"
                                className="flex items-center gap-1.5"
                                data-embed-keyboard-selected={isKeyboardSelected ? "true" : undefined}
                                style={{ color, fontSize: `${fontSize}px`, ...keyboardSelectionStyle }}
                            >
                                <ChevronRight size={fontSize * 0.8} className="opacity-70" />
                                <MathTitle text={displayTitle} className="font-semibold" />
                            </div>
                            <span className="text-[11px] font-mono text-secondary/80 bg-background px-1.5 py-0.5 rounded-md border border-outline/50 opacity-0 group-hover/embed:opacity-100 transition-opacity">{fullLabel}</span>
                        </div>
                        <span className="text-secondary/40 hover:text-secondary opacity-0 group-hover/embed:opacity-100 transition-all mr-1" title="Cmd/Ctrl + Click to open in new tab">
                            <ExternalLink size={14} />
                        </span>
                    </div>
                </div>
            );
        } else {
            const hasContent = targetBlock?.content !== undefined ? targetBlock.content.trim().length > 0 : !!targetBlock?.hasContent;
            const filledColor = settings?.inlineBlockTitleColorWithContent || "#a8b5c2";
            const emptyColor = settings?.inlineBlockTitleColorEmpty || "#FF997D";
            const underlineOpacity = settings?.inlineBlockTitleUnderlineOpacity ?? 100;
            const color = hasContent ? filledColor : emptyColor;
            return (
                <span 
                    ref={titleNavigationRef as React.RefObject<HTMLSpanElement>}
                    data-embed-nav-title="true"
                    className="inline border-b-2 border-dotted cursor-pointer mx-1 select-none font-semibold transition-colors opacity-90 hover:opacity-100"
                    data-embed-keyboard-selected={isKeyboardSelected ? "true" : undefined}
                    style={{ color, borderColor: `color-mix(in srgb, ${color} ${underlineOpacity}%, transparent)`, ...keyboardSelectionStyle }}
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

    const handleUp = (x?: number) => {
        if (view && pos !== undefined) {
            const titleRect = titleNavigationRef.current?.getBoundingClientRect();
            const anchor = typeof x === "number" && titleRect && x > (titleRect.left + titleRect.right) / 2
                ? pos + (length ?? 0)
                : pos;
            view.dispatch({
                selection: { anchor },
                effects: setEditorFocus.of(true)
            });
            view.focus();
        }
    };
    
    const handleDown = (x?: number) => {
        if (view && pos !== undefined && length !== undefined) {
            let nextPos = pos + length;
            if (isAtEndOfLine) {
                const doc = view.state.doc;
                const currentLine = doc.lineAt(nextPos);
                if (currentLine.number < doc.lines) {
                    nextPos = doc.line(currentLine.number + 1).from;
                } else if (handOffEditorBoundary(view, "down", x)) {
                    // This embedded block is the final visible row of its
                    // parent editor. Continue the same Down movement through
                    // the parent's boundary instead of landing on this title
                    // boundary, which would re-enter the child on the next Down.
                    return;
                }
            }
            if (typeof x === "number") {
                const targetCoords = view.coordsAtPos(nextPos, 1);
                if (targetCoords) {
                    nextPos = view.posAtCoords({
                        x,
                        y: (targetCoords.top + targetCoords.bottom) / 2
                    }, false);
                }
            }
            view.dispatch({
                selection: EditorSelection.cursor(nextPos, 1),
                effects: [
                    setEditorFocus.of(true),
                    setEmbeddedObjectSelection.of(null)
                ]
            });
            view.focus();
        }
    };

    const activateEmbeddedEditor = () => {
        setEditorActivated(true);
        if (!activeIsMe) {
            useStore.getState().setActiveBlock(targetBlock.id, "start", instancePath, pos);
            view?.contentDOM.blur();
        }
    };

    const embeddedEditorSurface = (
        <div ref={editorHostRef} data-testid={`embedded-editor-host-${targetBlock.id}`}>
            {editorActivated && targetBlock.content !== undefined ? (
                <CodeMirrorEditor
                    isReadOnly={isReadOnly}
                    content={targetBlock.content}
                    onBlur={(val) => {
                        useStore.getState().updateBlock(targetBlock.id, { content: val });
                        void useStore.getState().flushBlock(targetBlock.id);
                    }}
                    onChange={(val) => {
                        useStore.getState().updateBlock(targetBlock.id, { content: val });
                    }}
                    onUp={handleUp}
                    onDown={handleDown}
                    isFocused={isFocused}
                    macros={macros}
                    focusDirection={globalFocusDirection}
                    focusX={activeIsMe ? activeFocusX : null}
                    parentLabel={fullLabel}
                    visitedLabels={instancePath}
                    onImagePaste={(file, insertContent) => useStore.getState().setImageUploadParams({ file, onInsert: insertContent })}
                    onEsc={() => toggleOpen()}
                    onFocus={() => {
                        if (!activeIsMe) {
                            useStore.getState().setActiveBlock(targetBlock.id, null, instancePath, pos);
                        }
                    }}
                />
            ) : (
                <button
                    type="button"
                    className="block min-h-12 w-full cursor-text whitespace-pre-wrap rounded-md px-2 py-2 text-left font-sans text-sm text-secondary/70 hover:bg-accent/5"
                    onClick={(event) => {
                        event.stopPropagation();
                        activateEmbeddedEditor();
                    }}
                    aria-label={`Activate embedded editor ${displayTitle || fullLabel}`}
                >
                    {editorActivated
                        ? "Loading embedded note…"
                        : (targetBlock.content?.slice(0, 240) || "Preparing embedded note…")}
                </button>
            )}
        </div>
    );

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
        
        const level = visitedLabels.length + 1;
        const baseSize = settings?.standoutBlockTitleFontSizeBase ?? 24;
        const step = settings?.standoutBlockTitleFontSizeStep ?? 2;
        const minSize = settings?.standoutBlockTitleFontSizeMin ?? 18;
        const fontSize = Math.max(minSize, baseSize - (level - 1) * step);
        const lightenStep = settings?.standoutBlockBgLightenStep ?? 2;
        const bgLighten = level * lightenStep;
        const bgOpacityOpen = settings?.standoutBlockBgOpacityOpen ?? 80;
        const bgOpacityOpenHover = settings?.standoutBlockBgOpacityOpenHover ?? 90;
        
        return (
            <div
                className={`inline-block align-top ${isAtStartOfLine ? 'mt-0.5' : 'mt-1'} ${isAtEndOfLine ? 'mb-1.5' : 'mb-3'} select-none overflow-visible w-full`}
                style={{ 
                    marginLeft: indentWidth > 0 ? `${indentWidth}px` : undefined,
                    width: indentWidth > 0 ? `calc(100% - ${indentWidth}px)` : '100%'
                } as React.CSSProperties}
            >
                <div 
                    className="flex justify-between items-center cursor-pointer transition-colors group/embed rounded-t-lg"
                    style={{ 
                        paddingLeft: `${titlePl}px`, 
                        paddingRight: `${titlePr}px`, 
                        paddingTop: `${titlePt}px`, 
                        paddingBottom: `${titlePb}px`,
                        "--standout-inner-bg-hover": `color-mix(in srgb, color-mix(in srgb, var(--color-surface), white ${bgLighten}%) ${bgOpacityOpenHover}%, transparent)`
                    } as React.CSSProperties}
                    onMouseDown={e => { e.preventDefault(); e.stopPropagation(); }}
                    onClick={handleClick}
                >
                    <div className="flex items-center gap-2.5">
                        <div
                            ref={titleNavigationRef as React.RefObject<HTMLDivElement>}
                            data-embed-nav-title="true"
                            data-embed-keyboard-selected={isKeyboardSelected ? "true" : undefined}
                            style={{ color, fontSize: `${fontSize}px`, ...keyboardSelectionStyle }}
                        >
                            <MathTitle text={displayTitle} className="font-semibold" />
                        </div>
                    </div>
                    <div className="flex items-center gap-3 opacity-0 group-hover/embed:opacity-100 transition-opacity">
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
                <div ref={bodyNavigationRef as React.RefObject<HTMLDivElement>} data-embed-nav-body="true" className="border-l-2 border-accent/30 bg-[var(--standout-inner-bg)] rounded-r-xl font-sans text-primary relative overflow-visible mt-1"
                     style={{ 
                         paddingLeft: `${contentPl}px`, 
                         paddingRight: `${contentPr}px`, 
                         paddingTop: `${contentPt}px`, 
                         paddingBottom: `${contentPb}px`,
                         "--standout-inner-bg": `color-mix(in srgb, color-mix(in srgb, var(--color-surface), white ${bgLighten}%) ${bgOpacityOpen}%, transparent)`
                     } as React.CSSProperties}
                     onClick={e => {
                         // Prevents clicking inside widget from blurring the view/widget inappropriately?
                         // e.stopPropagation() is already somewhat implicit for embedded elements, but let's be safe.
                         e.stopPropagation();
                     }}
                >
                    {embeddedEditorSurface}
                </div>
            </div>
        );
    } else {
        const hasContent = targetBlock?.content !== undefined ? targetBlock.content.trim().length > 0 : !!targetBlock?.hasContent;
        const filledColor = settings?.inlineBlockTitleColorWithContent || "#a8b5c2";
        const emptyColor = settings?.inlineBlockTitleColorEmpty || "#FF997D";
        const underlineOpacity = settings?.inlineBlockTitleUnderlineOpacity ?? 100;
        const color = hasContent ? filledColor : emptyColor;
        const indentWidth = settings?.inlineBlockIndentWidth ?? 16;
        return (
            <span className="inline align-top">
                <span 
                    ref={titleNavigationRef as React.RefObject<HTMLSpanElement>}
                    data-embed-nav-title="true"
                    className="inline border-b-2 border-dotted cursor-pointer mx-1 select-none font-semibold transition-colors opacity-90 hover:opacity-100"
                    data-embed-keyboard-selected={isKeyboardSelected ? "true" : undefined}
                    style={{ color, borderColor: `color-mix(in srgb, ${color} ${underlineOpacity}%, transparent)`, ...keyboardSelectionStyle }}
                    onMouseDown={e => { e.preventDefault(); e.stopPropagation(); }}
                    onClick={handleClick}
                    title={`Close ${displayTitle}`}
                >
                    <MathTitle text={displayTitle} />
                </span>
                <span ref={bodyNavigationRef as React.RefObject<HTMLSpanElement>} data-embed-nav-body="true" className={`inline-block w-full py-2 border-l-2 border-accent/30 select-text bg-surface/30 rounded-r-lg relative overflow-visible mt-1 mb-1`}
                     style={{ paddingLeft: `${indentWidth}px` }}
                     onClick={e => e.stopPropagation()}>
                    {embeddedEditorSurface}
                </span>
            </span>
        );
    }
}
