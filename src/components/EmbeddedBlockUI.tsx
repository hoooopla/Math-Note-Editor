import React, { useState, useEffect, useLayoutEffect, useRef, useMemo } from "react";
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
import { EMBEDDED_PREFETCH_AHEAD_SCREENS, scheduleEmbeddedBlockPrefetch, scheduleEmbeddedDescendantPrefetch } from "../lib/embedded-prefetch";
import {
    demoteEmbeddedOccurrence,
    initialEmbeddedEditorPhase,
    promoteEmbeddedOccurrence,
    registerEmbeddedOccurrence,
    subscribeEmbeddedEditorPhase,
    type EmbeddedEditorPhase
} from "../lib/embedded-editor-lifecycle";
function embeddedPathKey(path: string[]) {
    return JSON.stringify(path);
}

function occurrenceKeyContains(ancestorKey: string, descendantKey: string) {
    try {
        const ancestor = JSON.parse(ancestorKey) as unknown;
        const descendant = JSON.parse(descendantKey) as unknown;
        return Array.isArray(ancestor) && Array.isArray(descendant) && ancestor.length <= descendant.length &&
            ancestor.every((segment, index) => segment === descendant[index]);
    } catch {
        return false;
    }
}

export interface EmbeddedBlockUIProps {
    text: string;
    parentLabel: string;
    visitedLabels?: string[];
    occurrencePath?: string[];
    toggleOpen: (e?: React.MouseEvent) => void;
    view?: EditorView;
    stateRef?: { pos: number, length: number };
    
    isAtEndOfLine?: boolean;
    isAtStartOfLine?: boolean;
    isKeyboardSelected?: boolean;
    keyboardSelectionEdge?: "before" | "after";
    renderPart?: "full" | "title" | "body";
    onRendererReady?: () => void;
}

export function EmbeddedBlockUI({ text, parentLabel, visitedLabels = [], occurrencePath = [], toggleOpen, view, stateRef, isAtEndOfLine = false, isAtStartOfLine = false, isKeyboardSelected = false, keyboardSelectionEdge, renderPart = "full", onRendererReady }: EmbeddedBlockUIProps) {
    const pos = stateRef?.pos;
    const length = stateRef?.length;
    const parsedEmbed = parseEmbeddedText(text);
    const displayStyle: "standout" | "inline" = parsedEmbed.standout ? "standout" : "inline";
    const ifToggled: "open" | "closed" = parsedEmbed.open ? "open" : "closed";
    // A terminal open embed already contributes the surrounding editor's
    // source-line height. Repeating body padding/margins at every descendant
    // level turns a few nested final embeds into a large artificial void.
    // Collapse only terminal body spacing; real blank Markdown rows remain
    // untouched because they are owned by CodeMirror, not this component.
    const compactTerminalSpacing = isAtEndOfLine;
    const keyboardSelectionStyle: React.CSSProperties = isKeyboardSelected ? {
        outline: "1px dotted rgba(96, 165, 250, 0.92)",
        outlineOffset: "1px",
        borderRadius: 0
    } : {};
    const keyboardCaret = isKeyboardSelected && keyboardSelectionEdge ? (
        <span
            aria-hidden="true"
            data-testid="embedded-title-caret"
            className="embedded-title-caret pointer-events-none absolute top-1/2 h-[1.15em] -translate-y-1/2 border-l-2 border-accent"
            style={keyboardSelectionEdge === "before" ? { left: "-3px" } : { right: "-3px" }}
        />
    ) : null;
    
    const activePath = useStore(state => state.activePath);
    const activeOccurrenceKey = useStore(state => state.activeOccurrenceKey);
    const focusDirection = useStore(state => state.focusDirection);
    const activeFocusPos = useStore(state => state.activeFocusPos);
    const activeFocusX = useStore(state => state.activeFocusX);
    const loadBlockContent = useStore(state => state.loadBlockContent);
    const settings = useStore(state => state.settings);

    let displayTitle: string | null = parsedEmbed.alias;
    const fullLabel = resolveEmbeddedLabel(parsedEmbed, parentLabel);

    const targetBlockId = useStore(state => state.blockIdByLabel[fullLabel]);
    const targetBlock = useStore(state => targetBlockId ? state.blocksById[targetBlockId] : undefined);
    const blockLoadError = useStore(state => targetBlockId ? state.blockLoadErrors[targetBlockId] : undefined);
    const isLabelExisted = !!targetBlock;
    
    const backendMode = useStore(state => state.backendMode);
    const rootBlockId = useStore(state => state.blockIdByLabel[visitedLabels[0]]);
    const rootBlock = useStore(state => rootBlockId ? state.blocksById[rootBlockId] : undefined);
    const viewOnlyBlocks = useStore(state => state.viewOnlyBlocks);
    
    const targetViewOnly = targetBlock ? (viewOnlyBlocks[targetBlock.id] ?? (backendMode === "viewer")) : false;
    const rootViewOnly = rootBlock ? (viewOnlyBlocks[rootBlock.id] ?? (backendMode === "viewer")) : false;
    const isReadOnly = targetViewOnly || rootViewOnly || !!view?.state.readOnly;

    const instancePath = useMemo(() => [...visitedLabels, fullLabel], [fullLabel, visitedLabels.join("\u0000")]);
    const occurrenceSegment = `${targetBlock?.id || fullLabel}@${pos ?? "unknown"}`;
    const instanceOccurrencePath = useMemo(
        () => [...occurrencePath, occurrenceSegment],
        [occurrencePath.join("\u0000"), occurrenceSegment]
    );
    const instanceKey = embeddedPathKey(instanceOccurrencePath);
    const pathMatches = activePath && activePath.length === instancePath.length && activePath.every((l, i) => l === instancePath[i]);
    const activeInsideMe = activeOccurrenceKey
        ? occurrenceKeyContains(instanceKey, activeOccurrenceKey)
        : !!activePath && activePath.length >= instancePath.length && instancePath.every((label, index) => activePath[index] === label);
    const activeIsMe = activeOccurrenceKey
        ? activeOccurrenceKey === instanceKey
        : pathMatches && (activeFocusPos === null || activeFocusPos === pos);
    const isFocused = activeIsMe ?? false;
    const globalFocusDirection = activeIsMe ? focusDirection : null;
    const editorHostRef = useRef<HTMLDivElement>(null);
    const titleNavigationRef = useRef<HTMLElement>(null);
    const bodyNavigationRef = useRef<HTMLElement>(null);
    const [editorPhase, setEditorPhase] = useState<EmbeddedEditorPhase>(() => initialEmbeddedEditorPhase(instanceKey));
    const editorActivated = editorPhase === "hot";
    const rendersBody = renderPart !== "title";

    useEffect(() => {
        if (!rendersBody || ifToggled !== "open" || !targetBlock || targetBlock.content !== undefined) return;
        const host = editorHostRef.current;
        const loadWithAnchor = async () => {
            await loadBlockContent(targetBlock.id);
        };
        if (typeof IntersectionObserver === "undefined") {
            void scheduleEmbeddedBlockPrefetch(targetBlock.id, loadWithAnchor).catch(() => undefined);
            return;
        }
        if (!host) return;

        const panel = host.closest<HTMLElement>('[role="tabpanel"]');
        const lookAhead = Math.max(1600, (panel?.clientHeight || window.innerHeight) * EMBEDDED_PREFETCH_AHEAD_SCREENS);

        const observer = new IntersectionObserver(entries => {
            if (entries.some(entry => entry.isIntersecting)) {
                void scheduleEmbeddedBlockPrefetch(targetBlock.id, loadWithAnchor).catch(() => undefined);
                observer.disconnect();
            }
        }, { root: panel, rootMargin: `${Math.ceil(lookAhead)}px 0px` });
        observer.observe(host);
        return () => observer.disconnect();
    }, [ifToggled, targetBlock, loadBlockContent, rendersBody]);

    useEffect(() => {
        if (!rendersBody || ifToggled !== "open" || targetBlock?.content === undefined) return;
        const visitedIds = instancePath
            .map(label => useStore.getState().blockIdByLabel[label])
            .filter((id): id is string => Boolean(id));
        scheduleEmbeddedDescendantPrefetch(targetBlock.content, fullLabel, visitedIds);
    }, [fullLabel, ifToggled, instancePath.join(">"), targetBlock?.content, rendersBody]);

    useLayoutEffect(() => {
        const host = editorHostRef.current;
        if (!host || ifToggled !== "open" || targetBlock?.content === undefined) return;
        const unsubscribe = subscribeEmbeddedEditorPhase(instanceKey, setEditorPhase);
        const unregister = registerEmbeddedOccurrence(instanceKey, host);
        return () => {
            unsubscribe();
            unregister();
        };
    }, [ifToggled, instanceKey, targetBlock?.content !== undefined]);

    useEffect(() => {
        if (!rendersBody) return;
        if (ifToggled !== "open") {
            demoteEmbeddedOccurrence(instanceKey);
        }
    }, [ifToggled, instanceKey, rendersBody]);

    useEffect(() => {
        if (!rendersBody || !editorActivated || ifToggled !== "open" || activeInsideMe) return;
        // Passive effects can run after a keyboard handoff has already changed
        // the active occurrence. A stale render must not demote that ancestry.
        const currentOccurrence = useStore.getState().activeOccurrenceKey;
        if (currentOccurrence && occurrenceKeyContains(instanceKey, currentOccurrence)) return;
        const panel = editorHostRef.current?.closest<HTMLElement>('[role="tabpanel"]');
        // Each mounted tab retains its own hot occurrence. Hiding a tab must
        // not discard the nested cursor and undo state that will be restored
        // when that tab becomes active again.
        if (panel?.getAttribute("aria-hidden") === "true") return;
        // Keep the already-mounted view and its exact geometry, but return it
        // to inexpensive, non-editable dormant mode when another block wins
        // focus.
        demoteEmbeddedOccurrence(instanceKey);
    }, [activeInsideMe, editorActivated, ifToggled, instanceKey, rendersBody]);

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
        // An open link has separate title and body widgets. A missing target
        // has no body, so render its correction chip only at the title.
        if (renderPart === "body") return null;
        const handleMissingClick = (event: React.MouseEvent) => {
            event.preventDefault();
            event.stopPropagation();
            if (!view || pos === undefined || length === undefined || isReadOnly) return;
            // Probe inside the target, not at the end of the Markdown token:
            // the trailing open marker (∨) is outside the editable label.
            const target = findActiveEmbeddedTarget(view.state.doc.toString(), pos + 2 + (text.startsWith("@") ? 1 : 0));
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
                    <div className="flex min-w-0 items-center justify-between gap-3"
                         style={{ 
                             paddingLeft: `${titlePl}px`, 
                             paddingRight: `${titlePr}px`, 
                             paddingTop: `${titlePt}px`, 
                             paddingBottom: `${titlePb}px` 
                         }}>
                        <div className="flex min-w-0 flex-1 items-center gap-2.5">
                            <div
                                ref={titleNavigationRef as React.RefObject<HTMLDivElement>}
                                data-embed-nav-title="true"
                                className="relative flex max-w-full shrink-0 items-center gap-1.5 [&>span]:min-w-0 [&>span]:break-words"
                                data-embed-keyboard-selected={isKeyboardSelected ? "true" : undefined}
                                style={{ color, fontSize: `${fontSize}px`, ...keyboardSelectionStyle }}
                            >
                                <ChevronRight size={fontSize * 0.8} className="shrink-0 opacity-70" />
                                <MathTitle text={displayTitle} className="font-semibold" />
                                {keyboardCaret}
                            </div>
                            <span data-testid={`standout-label-${targetBlock.id}`} className="standout-label-tail min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[11px] font-mono text-secondary/80 bg-background px-1.5 py-0.5 rounded-md border border-outline/50 opacity-0 group-hover/embed:opacity-100 transition-opacity" title={fullLabel} aria-label={`Label ${fullLabel}`}>{fullLabel}</span>
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
                    className="relative inline border-b-2 border-dotted cursor-pointer mx-1 select-none font-semibold transition-colors opacity-90 hover:opacity-100"
                    data-embed-keyboard-selected={isKeyboardSelected ? "true" : undefined}
                    style={{ color, borderColor: `color-mix(in srgb, ${color} ${underlineOpacity}%, transparent)`, ...keyboardSelectionStyle }}
                    onMouseDown={e => { e.preventDefault(); e.stopPropagation(); }}
                    onClick={handleClick}
                >
                    <MathTitle text={displayTitle} />
                    {keyboardCaret}
                </span>
            );
        }
    }

    // if_toggled = open
    const macros = useStore.getState().settings?.macros || {};

    const activateParentEditor = (x?: number) => {
        const store = useStore.getState();
        const parentBlockId = store.blockIdByLabel[parentLabel];
        const parentOccurrenceKey = occurrencePath.length > 0 ? embeddedPathKey(occurrencePath) : null;
        if (parentOccurrenceKey) promoteEmbeddedOccurrence(parentOccurrenceKey);
        if (parentBlockId) {
            store.setActiveBlock(parentBlockId, null, visitedLabels, null, x ?? null, parentOccurrenceKey);
        }
    };

    const handleUp = (x?: number) => {
        if (view && pos !== undefined) {
            const titleElement = titleNavigationRef.current || view.dom.querySelector<HTMLElement>(
                `.cm-embedded-block-wrapper[data-embed-from="${pos}"][data-embed-part="title"] [data-embed-nav-title]`
            );
            const titleRect = titleElement?.getBoundingClientRect();
            const anchor = typeof x === "number" && titleRect && x > (titleRect.left + titleRect.right) / 2
                ? pos + (length ?? 0)
                : pos;
            view.dispatch({
                selection: { anchor },
                effects: setEditorFocus.of(true)
            });
            activateParentEditor(x);
            view.focus();
        }
    };
    
    const handleDown = (x?: number) => {
        if (view && pos !== undefined && length !== undefined) {
            let nextPos = pos + length;
            const doc = view.state.doc;
            let enteredInlineContinuation = false;
            if (isAtEndOfLine) {
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
            } else {
                // The body block and the inline continuation share link.to.
                // Land after indentation/spacing so CodeMirror has an
                // unambiguous suffix-side caret instead of mapping the shared
                // boundary back beside the title replacement.
                const currentLine = doc.lineAt(nextPos);
                const continuation = doc.sliceString(nextPos, currentLine.to);
                nextPos += continuation.match(/^[\t ]*/)?.[0].length ?? 0;
                enteredInlineContinuation = true;
            }
            if (typeof x === "number" && !enteredInlineContinuation) {
                const targetCoords = view.coordsAtPos(nextPos, 1);
                if (targetCoords) {
                    const targetLine = doc.lineAt(nextPos);
                    const mapped = view.posAtCoords({
                        x,
                        y: (targetCoords.top + targetCoords.bottom) / 2
                    }, false);
                    // Preserve the desired column without allowing a later,
                    // wider decoration (usually block math) to capture the
                    // handoff away from this logical source row.
                    nextPos = Math.max(targetLine.from, Math.min(targetLine.to, mapped));
                }
            }
            view.dispatch({
                selection: EditorSelection.cursor(nextPos, 1),
                effects: [
                    setEditorFocus.of(true),
                    setEmbeddedObjectSelection.of(null)
                ]
            });
            activateParentEditor(x);
            view.focus();
        }
    };

    const embeddedEditorSurface = (
        <div
            ref={editorHostRef}
            data-testid={`embedded-editor-host-${targetBlock.id}`}
            data-occurrence-key={instanceKey}
            data-editor-activated={editorActivated ? "true" : "false"}
            data-editor-mounted="true"
            data-editor-phase={editorPhase}
            data-near-viewport="true"
            data-scroll-state="idle"
            style={{ overflowAnchor: "none" }}
        >
            {targetBlock.content !== undefined ? (
                <div className="block">
                    <div className="embedded-editor-live block"><CodeMirrorEditor
                    isReadOnly={isReadOnly}
                    isDormant={!editorActivated}
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
                    stateCacheKey={`embedded:${targetBlock.id}:${instanceKey}`}
                    stateCacheGroup={rootBlockId}
                    parentLabel={fullLabel}
                    visitedLabels={instancePath}
                    occurrencePath={instanceOccurrencePath}
                    onReady={() => {
                        requestAnimationFrame(() => {
                            requestAnimationFrame(() => {
                                onRendererReady?.();
                            });
                        });
                    }}
                    onImagePaste={(file, insertContent, assertInsertable) => useStore.getState().setImageUploadParams({ file, onInsert: insertContent, assertInsertable })}
                    onEsc={() => toggleOpen()}
                    onFocus={() => {
                        promoteEmbeddedOccurrence(instanceKey);
                        if (!activeIsMe) {
                            useStore.getState().setActiveBlock(targetBlock.id, null, instancePath, pos, null, instanceKey);
                        }
                    }}
                /></div>
                </div>
            ) : blockLoadError ? (
                <div
                    className="block min-h-12 w-full rounded border border-red-400/35 bg-red-400/10 px-3 py-2 text-sm text-red-200"
                    data-testid={`embedded-load-error-${targetBlock.id}`}
                    role="alert"
                >
                    <div>Could not load this embedded note.</div>
                    <div className="mt-0.5 break-words text-xs opacity-80">{blockLoadError}</div>
                    <button
                        type="button"
                        className="mt-2 rounded border border-red-300/50 px-2 py-1 text-xs font-semibold hover:bg-red-300/10"
                        onMouseDown={event => {
                            event.preventDefault();
                            event.stopPropagation();
                        }}
                        onClick={event => {
                            event.preventDefault();
                            event.stopPropagation();
                            void loadBlockContent(targetBlock.id).catch(() => undefined);
                        }}
                    >
                        Retry loading
                    </button>
                </div>
            ) : (
                <div
                    className="block min-h-12 w-full space-y-2 py-2"
                    aria-label={`Loading embedded note ${displayTitle || fullLabel}`}
                >
                    <span className="block h-2.5 w-4/5 rounded bg-outline/45" />
                    <span className="block h-2.5 w-3/5 rounded bg-outline/35" />
                </div>
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
        
        const outerStyle = {
            marginLeft: indentWidth > 0 ? `${indentWidth}px` : undefined,
            width: indentWidth > 0 ? `calc(100% - ${indentWidth}px)` : '100%'
        } as React.CSSProperties;
        const title = (
            <span
                className={`inline-flex align-top ${isAtStartOfLine ? 'mt-0.5' : 'mt-1'} select-none overflow-visible w-full`}
                style={outerStyle}
            >
                <span
                    className="flex min-w-0 justify-between items-center gap-3 cursor-pointer transition-colors group/embed rounded-t-lg"
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
                    <span className="flex max-w-full shrink-0 items-center gap-2.5">
                        <span
                            ref={titleNavigationRef as React.RefObject<HTMLSpanElement>}
                            data-embed-nav-title="true"
                            data-embed-keyboard-selected={isKeyboardSelected ? "true" : undefined}
                            className="relative min-w-0 max-w-full [&>span]:break-words"
                            style={{ color, fontSize: `${fontSize}px`, ...keyboardSelectionStyle }}
                        >
                            <MathTitle text={displayTitle} className="font-semibold" />
                            {keyboardCaret}
                        </span>
                    </span>
                    <span className="flex min-w-0 flex-1 items-center gap-3 opacity-0 group-hover/embed:opacity-100 transition-opacity">
                        <span data-testid={`standout-label-${targetBlock.id}`} className="standout-label-tail min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[11px] font-mono text-secondary/80 bg-background px-1.5 py-0.5 rounded-md border border-outline/50" title={fullLabel} aria-label={`Label ${fullLabel}`}>{fullLabel}</span>
                        <span className="text-secondary/40 hover:text-secondary transition-colors" title="Cmd/Ctrl + Click to open in new tab"
                              onClick={(e) => {
                                  e.stopPropagation();
                                  useStore.getState().openBlockInTab(targetBlock!.id, true);
                              }}
                        >
                            <ExternalLink size={14} />
                        </span>
                    </span>
                </span>
            </span>
        );
        const body = (
            <div
                className={`inline-block align-top ${compactTerminalSpacing ? 'mb-0' : 'mb-3'} select-none overflow-visible w-full`}
                style={{
                    ...outerStyle
                }}
            >
                <div ref={bodyNavigationRef as React.RefObject<HTMLDivElement>} data-embed-nav-body="true" className="border-l-2 border-accent/30 bg-[var(--standout-inner-bg)] rounded-r-xl font-sans text-primary relative overflow-visible mt-1"
                     style={{ 
                         paddingLeft: `${contentPl}px`, 
                         paddingRight: `${contentPr}px`, 
                         paddingTop: `${contentPt}px`, 
                         paddingBottom: `${compactTerminalSpacing ? 4 : contentPb}px`,
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
        if (renderPart === "title") return title;
        if (renderPart === "body") return body;
        return (
            <div className="w-full">
                {title}
                {body}
            </div>
        );
    } else {
        const hasContent = targetBlock?.content !== undefined ? targetBlock.content.trim().length > 0 : !!targetBlock?.hasContent;
        const filledColor = settings?.inlineBlockTitleColorWithContent || "#a8b5c2";
        const emptyColor = settings?.inlineBlockTitleColorEmpty || "#FF997D";
        const underlineOpacity = settings?.inlineBlockTitleUnderlineOpacity ?? 100;
        const color = hasContent ? filledColor : emptyColor;
        const indentWidth = settings?.inlineBlockIndentWidth ?? 16;
        const title = (
            <span
                    ref={titleNavigationRef as React.RefObject<HTMLSpanElement>}
                    data-embed-nav-title="true"
                    className="relative inline border-b-2 border-dotted cursor-pointer mx-1 select-none font-semibold transition-colors opacity-90 hover:opacity-100"
                    data-embed-keyboard-selected={isKeyboardSelected ? "true" : undefined}
                    style={{ color, borderColor: `color-mix(in srgb, ${color} ${underlineOpacity}%, transparent)`, ...keyboardSelectionStyle }}
                    onMouseDown={e => { e.preventDefault(); e.stopPropagation(); }}
                    onClick={handleClick}
                    title={`Close ${displayTitle}`}
                >
                    <MathTitle text={displayTitle} />
                    {keyboardCaret}
            </span>
        );
        const body = (
            <span ref={bodyNavigationRef as React.RefObject<HTMLSpanElement>} data-embed-nav-body="true" className={`block w-full ${compactTerminalSpacing ? 'pt-2 pb-1 mb-0' : 'py-2 mb-1'} border-l-2 border-accent/30 select-text bg-surface/30 rounded-r-lg relative overflow-visible mt-1`}
                     style={{
                         paddingLeft: `${indentWidth}px`
                     }}
                     onClick={e => e.stopPropagation()}>
                    {embeddedEditorSurface}
            </span>
        );
        if (renderPart === "title") return title;
        if (renderPart === "body") return body;
        return (
            <span className="inline align-top">
                {title}
                {body}
            </span>
        );
    }
}
