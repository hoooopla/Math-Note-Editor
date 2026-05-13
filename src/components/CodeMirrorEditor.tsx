import { useEffect, useRef } from "react";
import { EditorState, StateEffect, Compartment, Transaction } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";
import { history, defaultKeymap, historyKeymap } from "@codemirror/commands";
import { mathPlugin, livePreviewMacros, editorFocusField, setEditorFocus, parsedRangesField, mathTooltipField } from "../lib/editor/katex-plugin";
import { blockNavigation } from "../lib/editor/navigation";
import { autocompletion, closeBrackets } from "@codemirror/autocomplete";
import { latexCompletion } from "../lib/editor/latex-autocomplete";
import { embeddedBlockPlugin, parentLabelFacet, visitedLabelsFacet, parsedLinksField, embedTooltipField, embedKeymap } from "../lib/editor/embedded-block-plugin";

let isGlobalMousePressed = false;
if (typeof window !== "undefined") {
    window.addEventListener("mousedown", () => { isGlobalMousePressed = true; }, true);
    window.addEventListener("mouseup", () => { isGlobalMousePressed = false; }, true);
}

export interface CodeMirrorEditorProps {
    content: string;
    onBlur: (val: string) => void;
    onChange?: (val: string) => void;
    onUp: () => void;
    onDown: () => void;
    isFocused: boolean;
    macros: Record<string, string>;
    focusDirection: "start" | "end" | null;
    onFocus?: () => void;
    parentLabel?: string;
    visitedLabels?: string[];
    onEsc?: () => void;
}

export function CodeMirrorEditor({ content, onBlur, onChange, onUp, onDown, isFocused, macros, focusDirection, onFocus, parentLabel, visitedLabels, onEsc }: CodeMirrorEditorProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const onBlurRef = useRef(onBlur);
    const onChangeRef = useRef(onChange);
    const onFocusRef = useRef(onFocus);
    const onUpRef = useRef(onUp);
    const onDownRef = useRef(onDown);
    const parentLabelRef = useRef(parentLabel);
    const visitedLabelsRef = useRef(visitedLabels);
    const onEscRef = useRef(onEsc);

    useEffect(() => {
        onBlurRef.current = onBlur;
    }, [onBlur]);

    useEffect(() => {
        onChangeRef.current = onChange;
    }, [onChange]);

    useEffect(() => {
        onFocusRef.current = onFocus;
    }, [onFocus]);
    
    useEffect(() => {
        onUpRef.current = onUp;
    }, [onUp]);

    useEffect(() => {
        onDownRef.current = onDown;
    }, [onDown]);
    
    useEffect(() => {
        onEscRef.current = onEsc;
    }, [onEsc]);

    const parentLabelCompartmentRef = useRef(new Compartment());
    const visitedLabelsCompartmentRef = useRef(new Compartment());
    const macrosCompartmentRef = useRef(new Compartment());

    useEffect(() => {
        if (!containerRef.current) return;
        
        const customKeymap = keymap.of([
            {
                key: "Escape",
                run: () => {
                    if (onEscRef.current) {
                        onEscRef.current();
                        return true;
                    }
                    return false;
                }
            }
        ]);
        
        const state = EditorState.create({
            doc: content,
            extensions: [
                oneDark,
                EditorView.lineWrapping,
                history(),
                customKeymap,
                keymap.of(embedKeymap),
                keymap.of([...defaultKeymap, ...historyKeymap]),
                markdown(),
                EditorState.languageData.of(() => [{ closeBrackets: { brackets: ["(", "[", "{", "'", '"', "$"] } }]),
                macrosCompartmentRef.current.of(livePreviewMacros.of(macros)),
                parentLabelCompartmentRef.current.of(parentLabelFacet.of(parentLabelRef.current || "")),
                visitedLabelsCompartmentRef.current.of(visitedLabelsFacet.of(visitedLabelsRef.current || [])),
                editorFocusField,
                parsedRangesField,
                mathTooltipField,
                mathPlugin,
                parsedLinksField,
                embeddedBlockPlugin,
                embedTooltipField,
                closeBrackets(),
                autocompletion({ override: [latexCompletion] }),
                blockNavigation(() => onUpRef.current(), () => onDownRef.current()),
                EditorView.domEventHandlers({
                    focus: (e, view) => {
                        if (onFocusRef.current) {
                            if (isGlobalMousePressed) {
                                const handleMouseUp = () => {
                                    window.removeEventListener("mouseup", handleMouseUp);
                                    // Delay to let CodeMirror finish mouseup handling
                                    setTimeout(() => {
                                        if (onFocusRef.current && view.hasFocus) {
                                            onFocusRef.current();
                                        }
                                    }, 0);
                                };
                                window.addEventListener("mouseup", handleMouseUp);
                            } else {
                                onFocusRef.current();
                            }
                        }
                        return false;
                    }
                }),
                EditorView.updateListener.of((update) => {
                    const isUserEvent = update.transactions.some(tr => Boolean(tr.annotation(Transaction.userEvent)));
                    if (update.docChanged && onChangeRef.current && isUserEvent) {
                        onChangeRef.current(update.state.doc.toString());
                    }
                    // Sync only when focus is lost to prevent React from re-rendering the app rapidly
                    if (update.focusChanged && !update.view.hasFocus) {
                        onBlurRef.current(update.state.doc.toString());
                    }
                }),
                EditorView.theme({
                    "&": {
                        backgroundColor: "transparent !important",
                        fontSize: "16px",
                        fontFamily: "var(--font-sans)",
                        outline: "none",
                        overflow: "visible"
                    },
                    "&.cm-focused": { outline: "none" },
                    ".cm-content": { caretColor: "var(--color-accent)", padding: "0", color: "var(--color-primary) !important", fontFamily: "var(--font-sans) !important" },
                    ".cm-line": { padding: "0", lineHeight: "1.6" },
                    ".cm-gutters": { backgroundColor: "transparent !important", color: "var(--color-secondary)", border: "none" },
                    ".cm-selectionBackground, .cm-content ::selection": {
                        backgroundColor: "rgba(100, 150, 255, 0.4) !important"
                    },
                    "&.cm-focused .cm-selectionBackground": {
                        backgroundColor: "rgba(100, 150, 255, 0.4) !important"
                    },
                    ".cm-tooltip": {
                        border: "none",
                        backgroundColor: "transparent",
                        zIndex: "9999"
                    },
                    ".cm-scroller": {
                        overflow: "visible !important"
                    }
                })
            ]
        });

        const view = new EditorView({
            state,
            parent: containerRef.current
        });

        viewRef.current = view;

        return () => {
            view.destroy();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []); 

    useEffect(() => {
        if (viewRef.current) {
            viewRef.current.dispatch({ effects: setEditorFocus.of(isFocused) });
        }

        if (isFocused && viewRef.current && !viewRef.current.hasFocus) {
            viewRef.current.focus();
            
            if (focusDirection === "end") {
                const len = viewRef.current.state.doc.length;
                viewRef.current.dispatch({
                    selection: { anchor: len }
                });
            } else if (focusDirection === "start") {
                viewRef.current.dispatch({
                    selection: { anchor: 0 }
                });
            }
        }
    }, [isFocused, focusDirection]);

    // Sync external content changes
    useEffect(() => {
        if (viewRef.current) {
            const currentDoc = viewRef.current.state.doc.toString();
            if (content !== currentDoc && (!viewRef.current.hasFocus || currentDoc === "")) {
                let start = 0;
                while (start < currentDoc.length && start < content.length && currentDoc[start] === content[start]) {
                    start++;
                }
                
                let endCurrent = currentDoc.length - 1;
                let endContent = content.length - 1;
                while (endCurrent >= start && endContent >= start && currentDoc[endCurrent] === content[endContent]) {
                    endCurrent--;
                    endContent--;
                }
                
                viewRef.current.dispatch({
                    changes: { 
                        from: start, 
                        to: endCurrent + 1, 
                        insert: content.slice(start, endContent + 1) 
                    }
                });
            }
        }
    }, [content]);

    // Parent label, visited labels, and macros dynamic update
    useEffect(() => {
        let effects = [];
        if (viewRef.current) {
            if (parentLabel !== parentLabelRef.current) {
                parentLabelRef.current = parentLabel;
                effects.push(parentLabelCompartmentRef.current.reconfigure(parentLabelFacet.of(parentLabel || "")));
            }
            if (JSON.stringify(visitedLabels) !== JSON.stringify(visitedLabelsRef.current)) {
                visitedLabelsRef.current = visitedLabels;
                effects.push(visitedLabelsCompartmentRef.current.reconfigure(visitedLabelsFacet.of(visitedLabels || [])));
            }
            // reconfigure macros when they change
            effects.push(macrosCompartmentRef.current.reconfigure(livePreviewMacros.of(macros)));
            if (effects.length > 0) {
                viewRef.current.dispatch({ effects });
            }
        }
    }, [parentLabel, visitedLabels, macros]);

    return <div ref={containerRef} className="w-full" />;
}
