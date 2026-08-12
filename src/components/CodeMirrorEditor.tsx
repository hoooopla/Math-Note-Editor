import { useEffect, useRef } from "react";
import { EditorState, StateEffect, Compartment, Transaction, Prec, EditorSelection } from "@codemirror/state";
import { EditorView, keymap, drawSelection, dropCursor } from "@codemirror/view";
import { markdown, insertNewlineContinueMarkup } from "@codemirror/lang-markdown";
import { mathMarkdownExtension } from "../lib/editor/math-markdown-extension";
import { oneDark } from "@codemirror/theme-one-dark";
import { history, defaultKeymap, historyKeymap, cursorLineStart, cursorLineEnd, selectLineStart, selectLineEnd } from "@codemirror/commands";
import { mathPlugin, livePreviewMacros, editorFocusField, setEditorFocus, parsedRangesField, mathTooltipField } from "../lib/editor/katex-plugin";
import { blockNavigation } from "../lib/editor/navigation";
import { autocompletion, closeBrackets, closeBracketsKeymap, acceptCompletion, completionStatus, closeCompletion, startCompletion } from "@codemirror/autocomplete";
import { latexCompletion } from "../lib/editor/latex-autocomplete";
import { linkCompletion } from "../lib/editor/link-autocomplete";
import { textCompletion } from "../lib/editor/text-autocomplete";
import { embeddedBlockPlugin, parentLabelFacet, visitedLabelsFacet, parsedLinksField, embedTooltipField, embedKeymap } from "../lib/editor/embedded-block-plugin";
import { ligaturePlugin } from "../lib/editor/ligature-plugin";
import { imagePlugin } from "../lib/editor/image-plugin";
import { urlPlugin } from "../lib/editor/url-plugin";
import { autoReplaceFilter } from "../lib/editor/auto-replace";

let isGlobalMousePressed = false;
if (typeof window !== "undefined") {
    window.addEventListener("mousedown", () => { isGlobalMousePressed = true; }, true);
    window.addEventListener("mouseup", () => { isGlobalMousePressed = false; }, true);
}

export interface CodeMirrorEditorProps {
    isReadOnly?: boolean;
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
    onImagePaste?: (file: File, insertContent: (text: string) => void) => void;
}

export function CodeMirrorEditor({ isReadOnly, content, onBlur, onChange, onUp, onDown, isFocused, macros, focusDirection, onFocus, parentLabel, visitedLabels, onEsc, onImagePaste }: CodeMirrorEditorProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const isProgrammaticFocusRef = useRef(false);
    const onBlurRef = useRef(onBlur);
    const onChangeRef = useRef(onChange);
    const onFocusRef = useRef(onFocus);
    const onUpRef = useRef(onUp);
    const onDownRef = useRef(onDown);
    const parentLabelRef = useRef(parentLabel);
    const visitedLabelsRef = useRef(visitedLabels);
    const onEscRef = useRef(onEsc);
    const onImagePasteRef = useRef(onImagePaste);

    useEffect(() => {
        onImagePasteRef.current = onImagePaste;
    }, [onImagePaste]);

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
    const readOnlyCompartmentRef = useRef(new Compartment());

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
            },
            {
                key: "ArrowUp",
                run: (view) => {
                    const selection = view.state.selection.main;
                    if (!selection.empty) return false;
                    
                    const ranges = view.state.field(parsedRangesField, false);
                    if (!ranges) return false;
                    
                    const currentLine = view.state.doc.lineAt(selection.from);
                    if (currentLine.number <= 1) return false;
                    
                    const prevLine = view.state.doc.line(currentLine.number - 1);
                    const blockMathAbove = ranges.find(r => r.type === "blockMath" && r.from <= prevLine.to && r.to >= prevLine.from);
                    
                    if (blockMathAbove && selection.from > blockMathAbove.to) {
                        view.dispatch({
                            selection: { anchor: blockMathAbove.to },
                            effects: setEditorFocus.of(true)
                        });
                        return true;
                    }
                    return false;
                }
            },
            {
                key: "ArrowDown",
                run: (view) => {
                    const selection = view.state.selection.main;
                    if (!selection.empty) return false;
                    
                    const ranges = view.state.field(parsedRangesField, false);
                    if (!ranges) return false;
                    
                    const currentLine = view.state.doc.lineAt(selection.from);
                    if (currentLine.number >= view.state.doc.lines) return false;
                    
                    const nextLine = view.state.doc.line(currentLine.number + 1);
                    const blockMathBelow = ranges.find(r => r.type === "blockMath" && r.from <= nextLine.to && r.to >= nextLine.from);
                    
                    if (blockMathBelow && selection.from < blockMathBelow.from) {
                        view.dispatch({
                            selection: { anchor: blockMathBelow.from },
                            effects: setEditorFocus.of(true)
                        });
                        return true;
                    }
                    return false;
                }
            },
            {
                key: "Enter",
                run: insertNewlineContinueMarkup
            },
            {
                key: "Mod-ArrowLeft",
                run: cursorLineStart
            },
            {
                key: "Mod-ArrowRight",
                run: cursorLineEnd
            },
            {
                key: "Shift-Mod-ArrowLeft",
                run: selectLineStart
            },
            {
                key: "Shift-Mod-ArrowRight",
                run: selectLineEnd
            }
        ]);

        const blockquoteKeymap = keymap.of([
            {
                key: "Enter",
                run: (view) => {
                    if (completionStatus(view.state) === "active") {
                        return false;
                    }

                    const selection = view.state.selection.main;
                    const head = selection.head;
                    const line = view.state.doc.lineAt(selection.from);
                    const lineText = line.text;

                    const isBlockquote = /^\s*>/.test(lineText);

                    if (isBlockquote) {
                        // Pressing Enter on an empty blockquote line (e.g. ">" or "> ") clears the ">" marker and exits to a blank line
                        if (/^\s*>\s*$/.test(lineText)) {
                            view.dispatch({
                                changes: { from: line.from, to: line.to, insert: "" },
                                selection: { anchor: line.from },
                                scrollIntoView: true,
                                userEvent: "input.type"
                            });
                            return true;
                        }

                        // If cursor is at the very start of the line before '>', insert a plain newline before '>'
                        if (selection.empty && head === line.from) {
                            view.dispatch({
                                changes: { from: line.from, insert: "\n" },
                                selection: { anchor: line.from + 1 },
                                scrollIntoView: true,
                                userEvent: "input.type"
                            });
                            return true;
                        }

                        const match = lineText.match(/^(\s*> ?)/);
                        const prefix = match ? (match[1].endsWith(" ") ? match[1] : match[1] + " ") : "> ";

                        view.dispatch({
                            changes: { from: selection.from, to: selection.to, insert: "\n" + prefix },
                            selection: { anchor: selection.from + 1 + prefix.length },
                            scrollIntoView: true,
                            userEvent: "input.type"
                        });
                        return true;
                    } else {
                        // Original line does NOT start with '>'.
                        // Prevent default markdown continuation (which auto-adds '>' for lazy blockquotes).
                        const indentMatch = lineText.match(/^(\s*)/);
                        const indent = indentMatch ? indentMatch[1] : "";

                        view.dispatch({
                            changes: { from: selection.from, to: selection.to, insert: "\n" + indent },
                            selection: { anchor: selection.from + 1 + indent.length },
                            scrollIntoView: true,
                            userEvent: "input.type"
                        });
                        return true;
                    }
                }
            }
        ]);
        
        const state = EditorState.create({
            doc: content,
            extensions: [
                oneDark,
                drawSelection(),
                dropCursor(),
                EditorView.lineWrapping,
                history(),
                customKeymap,
                Prec.highest(keymap.of(embedKeymap)),
                Prec.highest(blockquoteKeymap),
                keymap.of([{
                    key: "[",
                    run: (view) => {
                        const head = view.state.selection.main.head;
                        const doc = view.state.doc;
                        if (head > 0 && doc.sliceString(head - 1, head) === "\\") {
                            view.dispatch({
                                changes: { from: head, insert: "[\\]" },
                                selection: { anchor: head + 1 }
                            });
                            return true;
                        }
                        return false;
                    }
                }]),
                keymap.of([{
                    key: "$",
                    run: (view) => {
                        const state = view.state;
                        const changes = state.changeByRange(range => {
                            if (!range.empty) {
                                return {
                                    changes: [
                                        { insert: "$", from: range.from },
                                        { insert: "$", from: range.to }
                                    ],
                                    range: EditorSelection.range(range.anchor + 1, range.head + 1)
                                };
                            }
                            
                            const pos = range.head;
                            const nextChar = state.doc.sliceString(pos, pos + 1);
                            const prevChar = state.doc.sliceString(pos - 1, pos);
                            
                            if (nextChar === "$") {
                                return { range: EditorSelection.cursor(pos + 1) };
                            }
                            
                            if (prevChar === "\\") {
                                return {
                                    changes: { insert: "$", from: pos },
                                    range: EditorSelection.cursor(pos + 1)
                                };
                            }
                            
                            return {
                                changes: { insert: "$$", from: pos },
                                range: EditorSelection.cursor(pos + 1)
                            };
                        });
                        
                        if (changes.changes.empty) {
                            view.dispatch(changes);
                            return true;
                        }
                        
                        view.dispatch(state.update(changes, {
                            scrollIntoView: true,
                            userEvent: "input.type"
                        }));
                        return true;
                    }
                }]),
                keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap]),
                markdown({ addKeymap: false, extensions: [mathMarkdownExtension] }),
                EditorState.languageData.of(() => [{ closeBrackets: { brackets: ["(", "[", "{", "'", '"', "$"] } }]),
                macrosCompartmentRef.current.of(livePreviewMacros.of(macros)),
                parentLabelCompartmentRef.current.of(parentLabelFacet.of(parentLabelRef.current || "")),
                visitedLabelsCompartmentRef.current.of(visitedLabelsFacet.of(visitedLabelsRef.current || [])),
                readOnlyCompartmentRef.current.of([
                    EditorState.readOnly.of(!!isReadOnly),
                    EditorView.editable.of(!isReadOnly)
                ]),
                editorFocusField,
                parsedRangesField,
                mathTooltipField,
                mathPlugin,
                parsedLinksField,
                embeddedBlockPlugin,
                embedTooltipField,
                ligaturePlugin,
                imagePlugin,
                urlPlugin,
                autoReplaceFilter,
                EditorView.contentAttributes.of({ spellcheck: "true" }),
                closeBrackets(),
                keymap.of([{ 
                    key: "Tab", 
                    run: (view) => {
                        const head = view.state.selection.main.head;
                        const line = view.state.doc.lineAt(head);
                        const textBefore = line.text.slice(0, head - line.from);
                        const textAfter = line.text.slice(head - line.from);
                        
                        const matchBefore = textBefore.match(/\[\[([^\]\|]*)$/);
                        if (matchBefore) {
                            const matchAfter = textAfter.match(/^([^\]\|]*)/);
                            const replaceFrom = head - matchBefore[1].length;
                            const replaceTo = head + (matchAfter ? matchAfter[1].length : 0);
                            
                            const parentLabel = view.state.facet(parentLabelFacet);
                            if (parentLabel) {
                                view.dispatch({
                                    changes: { from: replaceFrom, to: replaceTo, insert: parentLabel },
                                    selection: { anchor: replaceFrom + parentLabel.length }
                                });
                                // also close autocomplete if open
                                closeCompletion(view);
                                return true;
                            }
                        }
                        return false;
                    } 
                }]),
                autocompletion({ override: [latexCompletion, linkCompletion, textCompletion] }),
                blockNavigation(() => onUpRef.current(), () => onDownRef.current()),
                EditorView.domEventHandlers({
                    paste: (e, view) => {
                        const textData = e.clipboardData?.getData("text/plain");
                        if (textData) {
                            const isUrl = /^https?:\/\/\S+$/.test(textData.trim());
                            if (isUrl) {
                                const selection = view.state.selection.main;
                                const selectedText = view.state.sliceDoc(selection.from, selection.to);
                                if (selectedText) {
                                    e.preventDefault();
                                    const replaceText = `[${selectedText}](${textData.trim()})`;
                                    view.dispatch({
                                        changes: { from: selection.from, to: selection.to, insert: replaceText },
                                        selection: { anchor: selection.from + replaceText.length }
                                    });
                                    return true;
                                }
                            }
                        }

                        if (e.clipboardData?.files && e.clipboardData.files.length > 0) {
                            for (let i = 0; i < e.clipboardData.files.length; i++) {
                                const file = e.clipboardData.files[i];
                                if (file.type.startsWith("image/")) {
                                    if (onImagePasteRef.current) {
                                        const cursorPos = view.state.selection.main.head;
                                        e.preventDefault();
                                        onImagePasteRef.current(file, (text) => {
                                            view.dispatch({
                                                changes: { from: cursorPos, insert: text },
                                                selection: { anchor: cursorPos + text.length }
                                            });
                                            view.focus();
                                        });
                                        return true;
                                    }
                                }
                            }
                        }
                        return false;
                    },
                    mousedown: (e, view) => {
                        const a = (e.target as Element)?.closest('a');
                        if (a && a.href) {
                            window.open(a.href, '_blank', 'noopener,noreferrer');
                            e.preventDefault();
                            return true;
                        }
                        return false;
                    },
                    focus: (e, view) => {
                        const targetEl = e.target as HTMLElement;
                        const wrapper = targetEl && targetEl.closest ? targetEl.closest(".cm-embedded-block-wrapper") : null;
                        if (wrapper && !wrapper.contains(view.dom)) {
                            return false;
                        }

                        if (isProgrammaticFocusRef.current) {
                            isProgrammaticFocusRef.current = false;
                            view.dispatch({ effects: setEditorFocus.of(true) });
                            return false;
                        }

                        view.dispatch({ effects: setEditorFocus.of(true) });
                        if (onFocusRef.current) {
                            if (isGlobalMousePressed) {
                                const handleMouseUp = () => {
                                    setTimeout(() => {
                                        if (onFocusRef.current && view.dom?.isConnected) {
                                            const isStillFocused = view.hasFocus || (containerRef.current ? containerRef.current.contains(document.activeElement) : false);
                                            if (isStillFocused) {
                                                onFocusRef.current();
                                            }
                                        }
                                    }, 0);
                                };
                                window.addEventListener("mouseup", handleMouseUp, { once: true });
                            } else {
                                onFocusRef.current();
                            }
                        }
                        return false;
                    },
                    blur: (e, view) => {
                        view.dispatch({ effects: setEditorFocus.of(false) });
                        return false;
                    }
                }),
                EditorView.updateListener.of((update) => {
                    const userEvent = update.transactions.map(tr => tr.annotation(Transaction.userEvent)).find(e => Boolean(e));
                    if (update.docChanged && onChangeRef.current && userEvent) {
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
                    ".cm-content": { caretColor: "var(--color-accent)", padding: "0", color: "var(--color-primary) !important", fontFamily: "var(--font-sans) !important", fontVariantLigatures: "contextual !important", fontFeatureSettings: '"calt" 1 !important' },
                    ".cm-cursor, .cm-dropCursor": { borderLeftWidth: "2px !important", borderLeftColor: "var(--color-accent) !important" },
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

        const isDOMFocused = viewRef.current ? (
            viewRef.current.hasFocus || 
            (containerRef.current ? containerRef.current.contains(document.activeElement) : false)
        ) : false;

        if (isFocused && viewRef.current && !isDOMFocused && !isReadOnly) {
            isProgrammaticFocusRef.current = true;
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
    }, [isFocused, focusDirection, isReadOnly]);

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

    const macrosRef = useRef(macros);

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
            if (JSON.stringify(macros) !== JSON.stringify(macrosRef.current)) {
                macrosRef.current = macros;
                effects.push(macrosCompartmentRef.current.reconfigure(livePreviewMacros.of(macros)));
            }
            effects.push(readOnlyCompartmentRef.current.reconfigure([
                EditorState.readOnly.of(!!isReadOnly),
                EditorView.editable.of(!isReadOnly)
            ]));
            if (effects.length > 0) {
                viewRef.current.dispatch({ effects });
            }
        }
    }, [parentLabel, visitedLabels, macros, isReadOnly]);

    return <div ref={containerRef} className="w-full" />;
}
