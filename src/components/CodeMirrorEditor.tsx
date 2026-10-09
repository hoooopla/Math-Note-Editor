import { useEffect, useLayoutEffect, useRef } from "react";
import { EditorState, StateEffect, Compartment, Transaction, Prec, EditorSelection } from "@codemirror/state";
import { EditorView, keymap, drawSelection, dropCursor } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { mathMarkdownExtension } from "../lib/editor/math-markdown-extension";
import { oneDark } from "@codemirror/theme-one-dark";
import { history, historyField, defaultKeymap, historyKeymap, cursorLineStart, cursorLineEnd, selectLineStart, selectLineEnd } from "@codemirror/commands";
import { mathPlugin, livePreviewMacros, editorFocusField, setEditorFocus, parsedRangesField, blockMathDecorationField, mathTooltipField, autoClosingDollarField, updateAutoClosingDollar, isDollarEscaped } from "../lib/editor/katex-plugin";
import { autocompletion, closeBrackets, closeBracketsKeymap, acceptCompletion, completionStatus, closeCompletion, startCompletion } from "@codemirror/autocomplete";
import { latexCompletion } from "../lib/editor/latex-autocomplete";
import { linkCompletion } from "../lib/editor/link-autocomplete";
import { textCompletion } from "../lib/editor/text-autocomplete";
import { clearEmbeddedVisualMove, clearTransientEmbeddedOpen, embeddedAtomicRanges, embeddedBlockPlugin, embeddedObjectInputHandler, embeddedObjectSelectionField, parentLabelFacet, visitedLabelsFacet, occurrencePathFacet, parsedLinksField, transientEmbeddedOpenField, embedTooltipField, enterOpenEmbeddedAtEnd, runEmbeddedKey, runEmbeddedGroupNavigation, openEmbeddedTargetInTab } from "../lib/editor/embedded-block-plugin";
import { runLogicalVerticalNavigation, scheduleFinalNavigationReveal } from "../lib/editor/logical-navigation";
import { ligaturePlugin } from "../lib/editor/ligature-plugin";
import { imagePlugin } from "../lib/editor/image-plugin";
import { urlPlugin } from "../lib/editor/url-plugin";
import { autoReplaceFilter } from "../lib/editor/auto-replace";
import { registerEditorBoundaryHandlers, unregisterEditorBoundaryHandlers } from "../lib/editor/editor-boundary-registry";
import { findActiveEmbeddedTarget } from "../lib/embedded-link-syntax";
import { scheduleEmbeddedDescendantPrefetch } from "../lib/embedded-prefetch";
import { useStore } from "../store";

let isGlobalMousePressed = false;
const editorStateCache = new Map<string, { doc: string; json: unknown; group?: string }>();
const MAX_CACHED_EDITOR_STATES = 256;

function trimEditorStateCache() {
    const protectedGroups = new Set(useStore.getState().openTabs);
    while (editorStateCache.size > MAX_CACHED_EDITOR_STATES) {
        const evictable = Array.from(editorStateCache.entries()).find(([, record]) =>
            !record.group || !protectedGroups.has(record.group)
        );
        if (!evictable) break;
        editorStateCache.delete(evictable[0]);
    }
}

function rememberEditorState(key: string, state: EditorState, group?: string) {
    editorStateCache.delete(key);
    editorStateCache.set(key, { doc: state.doc.toString(), json: state.toJSON({ history: historyField }), group });
    trimEditorStateCache();
}
if (typeof window !== "undefined") {
    window.addEventListener("mousedown", () => { isGlobalMousePressed = true; }, true);
    window.addEventListener("mouseup", () => { isGlobalMousePressed = false; }, true);
    window.addEventListener("math-note-workspace-reset", () => editorStateCache.clear());
}
useStore.subscribe((state, previousState) => {
    if (state.openTabs !== previousState.openTabs) trimEditorStateCache();
});

export interface CodeMirrorEditorProps {
    isReadOnly?: boolean;
    content: string;
    onBlur: (val: string) => void;
    onChange?: (val: string) => void;
    onUp?: (x?: number) => void;
    onDown?: (x?: number) => void;
    isFocused: boolean;
    macros: Record<string, string>;
    focusDirection: "start" | "end" | null;
    focusX?: number | null;
    focusRequestKey?: number;
    stateCacheKey?: string;
    stateCacheGroup?: string;
    isDormant?: boolean;
    onFocus?: () => void;
    parentLabel?: string;
    visitedLabels?: string[];
    occurrencePath?: string[];
    onEsc?: () => void;
    onImagePaste?: (file: File, insertContent: (text: string) => void, assertInsertable: () => void) => void;
    onReady?: (view: EditorView) => void;
}

export function CodeMirrorEditor({ isReadOnly, content, onBlur, onChange, onUp, onDown, isFocused, macros, focusDirection, focusX, focusRequestKey, stateCacheKey, stateCacheGroup, isDormant = false, onFocus, parentLabel, visitedLabels, occurrencePath, onEsc, onImagePaste, onReady }: CodeMirrorEditorProps) {
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
    const occurrencePathRef = useRef(occurrencePath);
    const onEscRef = useRef(onEsc);
    const onImagePasteRef = useRef(onImagePaste);
    const onReadyRef = useRef(onReady);
    const stateCacheGroupRef = useRef(stateCacheGroup);
    stateCacheGroupRef.current = stateCacheGroup;

    useEffect(() => {
        onReadyRef.current = onReady;
    }, [onReady]);

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
    const occurrencePathCompartmentRef = useRef(new Compartment());
    const macrosCompartmentRef = useRef(new Compartment());
    const readOnlyCompartmentRef = useRef(new Compartment());

    useEffect(() => {
        if (!parentLabel) return;
        const visitedIds = (visitedLabels || [])
            .map(label => useStore.getState().blockIdByLabel[label])
            .filter((id): id is string => Boolean(id));
        scheduleEmbeddedDescendantPrefetch(content, parentLabel, visitedIds);
    }, [content, parentLabel, (visitedLabels || []).join("\u0000")]);

    useLayoutEffect(() => {
        if (!containerRef.current) return;
        
        const customKeymap = keymap.of([
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

        const indentBlockMath = (view: EditorView, outdent = false) => {
            if (view.state.readOnly) return false;

            const selection = view.state.selection.main;
            const startLine = view.state.doc.lineAt(selection.from);
            let endLine = view.state.doc.lineAt(selection.to);
            if (!selection.empty && selection.to === endLine.from && endLine.number > startLine.number) {
                endLine = view.state.doc.line(endLine.number - 1);
            }

            const ranges = view.state.field(parsedRangesField, false);
            const blockMath = ranges?.find(range =>
                range.type === "blockMath" &&
                startLine.from >= range.from + 2 &&
                startLine.from < range.to - 2 &&
                endLine.to <= range.to - 2
            );
            if (!blockMath) return false;

            const changes = [];
            for (let lineNumber = startLine.number; lineNumber <= endLine.number; lineNumber++) {
                const line = view.state.doc.line(lineNumber);
                if (outdent) {
                    const leadingSpaces = line.text.match(/^ {1,2}/)?.[0].length ?? 0;
                    if (leadingSpaces > 0) changes.push({ from: line.from, to: line.from + leadingSpaces, insert: "" });
                } else {
                    changes.push({ from: line.from, insert: "  " });
                }
            }

            if (changes.length > 0) {
                view.dispatch({ changes, scrollIntoView: true, userEvent: "input.type" });
            }
            return true;
        };

        const continueMarkup = (view: EditorView) => {
                    if (completionStatus(view.state) === "active") return false;

                    const selection = view.state.selection.main;
                    const head = selection.head;
                    const line = view.state.doc.lineAt(selection.from);
                    const lineText = line.text;

                    const quoteMatch = lineText.match(/^(\s*)(>)(\s?)/);
                    const bulletMatch = lineText.match(/^(\s*)([*+-])(\s+)/);
                    const orderedMatch = lineText.match(/^(\s*)(\d+)([.)])(\s+)/);
                    const markerMatch = quoteMatch || bulletMatch || orderedMatch;

                    if (markerMatch) {
                        const markerEnd = markerMatch[0].length;
                        const content = lineText.slice(markerEnd);

                        // A second Enter on an empty marker exits the quote/list.
                        if (content.trim() === "") {
                            view.dispatch({
                                changes: { from: line.from, to: line.to, insert: "" },
                                selection: { anchor: line.from },
                                scrollIntoView: true,
                                userEvent: "input.type"
                            });
                            return true;
                        }

                        // Enter before the marker inserts a plain line above it.
                        if (selection.empty && head === line.from) {
                            view.dispatch({
                                changes: { from: line.from, insert: "\n" },
                                selection: { anchor: line.from + 1 },
                                scrollIntoView: true,
                                userEvent: "input.type"
                            });
                            return true;
                        }

                        let prefix: string;
                        if (orderedMatch) {
                            const nextNumber = Number.parseInt(orderedMatch[2], 10) + 1;
                            prefix = `${orderedMatch[1]}${nextNumber}${orderedMatch[3]}${orderedMatch[4]}`;
                        } else if (bulletMatch) {
                            prefix = bulletMatch[0];
                        } else {
                            prefix = `${quoteMatch![1]}> `;
                        }

                        view.dispatch({
                            changes: { from: selection.from, to: selection.to, insert: "\n" + prefix },
                            selection: { anchor: selection.from + 1 + prefix.length },
                            scrollIntoView: true,
                            userEvent: "input.type"
                        });
                        return true;
                    } else {
                        // Preserve indentation without continuing a lazy quote.
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
                };

        const moveWithinLinkCompletion = (view: EditorView, forward: boolean) => {
            if (completionStatus(view.state) === null) return false;
            const selection = view.state.selection.main;
            if (!selection.empty) return false;

            const before = findActiveEmbeddedTarget(view.state.doc.toString(), selection.head);
            if (!before) return false;
            const moved = view.moveByChar(selection, forward);
            if (moved.head === selection.head) return false;

            const after = findActiveEmbeddedTarget(view.state.doc.toString(), moved.head);
            view.dispatch({
                selection: moved,
                scrollIntoView: true,
                // CodeMirror resets completion on every ordinary selection
                // transaction. Treat movement that remains in the same link
                // target as a continuing completion interaction so the
                // existing tooltip updates without closing and reopening.
                annotations: after && after.from === before.from && after.to === before.to
                    ? Transaction.userEvent.of("input.type")
                    : undefined
            });
            return true;
        };

        const navigationKeymap = Prec.highest(keymap.of([
            {
                key: "Alt-ArrowLeft",
                run: view => runEmbeddedGroupNavigation(view, false)
            },
            {
                key: "Alt-ArrowRight",
                run: view => runEmbeddedGroupNavigation(view, true)
            },
            {
                key: "Backspace",
                run: view => runEmbeddedKey(view, "Backspace")
            },
            {
                key: "Delete",
                run: view => runEmbeddedKey(view, "Delete")
            },
            {
                key: "Mod-Enter",
                run: openEmbeddedTargetInTab
            },
            {
                key: "Escape",
                run: (view) => {
                    if (completionStatus(view.state) === "active") {
                        closeCompletion(view);
                        return true;
                    }
                    if (!onEscRef.current) return false;
                    onEscRef.current();
                    return true;
                }
            },
            {
                key: "Enter",
                run: (view) => {
                    if (completionStatus(view.state) === "active") return false;
                    return runEmbeddedKey(view, "Enter") || continueMarkup(view);
                }
            },
            {
                key: "ArrowLeft",
                run: (view) => moveWithinLinkCompletion(view, false) || runEmbeddedKey(view, "ArrowLeft")
            },
            {
                key: "ArrowRight",
                run: (view) => moveWithinLinkCompletion(view, true) || runEmbeddedKey(view, "ArrowRight")
            },
            {
                key: "ArrowUp",
                run: (view) => {
                    if (completionStatus(view.state) === "active") return false;
                    if (runLogicalVerticalNavigation(view, "up")) return true;
                    const selection = view.state.selection.main;
                    if (!onEscRef.current || !selection.empty) return false;
                    const moved = view.moveVertically(selection, false);
                    if (moved.head !== selection.head) {
                        const currentLine = view.state.doc.lineAt(selection.head).number;
                        const movedLine = view.state.doc.lineAt(moved.head).number;
                        // Preserve CodeMirror's same-line normalization (for
                        // example column one to column zero) and genuine moves
                        // to a visually higher wrapped/source row. Replacement
                        // widgets can otherwise return a different source
                        // position that is actually beside or below the caret.
                        if (currentLine === movedLine) return false;
                        const currentCoords = view.coordsAtPos(selection.head, -1);
                        const movedCoords = view.coordsAtPos(moved.head, -1);
                        if (movedCoords && currentCoords && movedCoords.top < currentCoords.top - 2) return false;
                    }
                    onUpRef.current?.(view.coordsAtPos(selection.head)?.left);
                    return true;
                }
            },
            {
                key: "ArrowDown",
                run: (view) => {
                    if (completionStatus(view.state) === "active") return false;
                    if (runLogicalVerticalNavigation(view, "down")) return true;
                    const selection = view.state.selection.main;
                    if (!onEscRef.current || !selection.empty) return false;
                    const moved = view.moveVertically(selection, true);
                    if (moved.head !== selection.head) {
                        const currentCoords = view.coordsAtPos(selection.head, 1);
                        const movedCoords = view.coordsAtPos(moved.head, 1);
                        // Only accept native movement when it is genuinely
                        // lower on screen. This mirrors the Up guard and keeps
                        // a replacement widget from redirecting Down into a
                        // different embedded occurrence.
                        if (movedCoords && currentCoords && movedCoords.top > currentCoords.top + 2) return false;
                    }
                    onDownRef.current?.(view.coordsAtPos(selection.head)?.left);
                    return true;
                }
            }
        ]));
        
        const extensions = [
                oneDark,
                drawSelection(),
                dropCursor(),
                EditorView.lineWrapping,
                history(),
                navigationKeymap,
                customKeymap,
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
                        const replacedEscapedClosers: Array<{ remove: number; add: number }> = [];
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
                                const trackedClosers = state.field(autoClosingDollarField);
                                if (trackedClosers.has(pos) && isDollarEscaped(state.doc.toString(), pos)) {
                                    replacedEscapedClosers.push({ remove: pos, add: pos + 1 });
                                    return {
                                        changes: { insert: "$", from: pos + 1 },
                                        range: EditorSelection.cursor(pos + 2)
                                    };
                                }
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

                        const autoCloserChanges: Array<{ add?: number; remove?: number }> = [];
                        changes.changes.iterChanges((_fromA, _toA, fromB, _toB, inserted) => {
                            if (inserted.toString() === "$$") {
                                autoCloserChanges.push({ add: fromB + 1 });
                            }
                        });
                        autoCloserChanges.push(...replacedEscapedClosers);

                        view.dispatch(state.update(changes, {
                            scrollIntoView: true,
                            userEvent: "input.type"
                        }));
                        if (autoCloserChanges.length > 0) {
                            view.dispatch({
                                effects: autoCloserChanges.map(change => updateAutoClosingDollar.of(change))
                            });
                        }
                        return true;
                    }
                }]),
                keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap]),
                markdown({ addKeymap: false, extensions: [mathMarkdownExtension] }),
                EditorState.languageData.of(() => [{ closeBrackets: { brackets: ["(", "[", "{", "'", '"', "$"] } }]),
                macrosCompartmentRef.current.of(livePreviewMacros.of(macros)),
                parentLabelCompartmentRef.current.of(parentLabelFacet.of(parentLabelRef.current || "")),
                visitedLabelsCompartmentRef.current.of(visitedLabelsFacet.of(visitedLabelsRef.current || [])),
                occurrencePathCompartmentRef.current.of(occurrencePathFacet.of(occurrencePathRef.current || [])),
                readOnlyCompartmentRef.current.of([
                    // Dormant editors are not user-editable, but their embedded
                    // title widgets still dispatch programmatic open/close
                    // transactions. Reserve state-level readOnly for genuinely
                    // read-only workspaces and use editable=false for dormancy.
                    EditorState.readOnly.of(!!isReadOnly),
                    // A dormant editor is still a normal CodeMirror surface.
                    // Dormancy controls focus ownership, not browser editing
                    // semantics, so the first drag/Shift-click/IME gesture is
                    // handled natively instead of being replayed synthetically.
                    EditorView.editable.of(!isReadOnly)
                ]),
                editorFocusField,
                autoClosingDollarField,
                parsedRangesField,
                blockMathDecorationField,
                mathTooltipField,
                mathPlugin,
                parsedLinksField,
                transientEmbeddedOpenField,
                embeddedObjectSelectionField,
                EditorView.editorAttributes.of(view => ({
                    class: view.state.field(embeddedObjectSelectionField, false)
                        ? "cm-embedded-object-selected"
                        : ""
                })),
                embeddedAtomicRanges,
                embeddedObjectInputHandler,
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
                        return indentBlockMath(view);
                    } 
                }, {
                    key: "Shift-Tab",
                    run: (view) => indentBlockMath(view, true)
                }]),
                autocompletion({
                    override: [latexCompletion, linkCompletion, textCompletion],
                    // Link completions provide their exact target and insertion text
                    // as CM6 selection info. Keep that info under the scrolling list.
                    positionInfo: () => ({ class: "cm-link-completion-footer", style: "position: static" })
                }),
                EditorView.domEventHandlers({
                    keydown: (e, view) => {
                        if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "Backspace", "Delete"].includes(e.key)) {
                            scheduleFinalNavigationReveal(view);
                        }
                        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") {
                            clearEmbeddedVisualMove(view);
                        }
                        return false;
                    },
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
                                        const selection = view.state.selection.main;
                                        const originalDoc = view.state.doc;
                                        const assertInsertable = () => {
                                            if (!view.dom.isConnected || view.state.readOnly) {
                                                throw new Error('The original note is no longer editable. Paste the image again in the intended note.');
                                            }
                                            if (view.state.doc !== originalDoc) {
                                                throw new Error('The note changed while the image picker was open. Paste the image again at the intended position.');
                                            }
                                        };
                                        e.preventDefault();
                                        onImagePasteRef.current(file, (text) => {
                                            assertInsertable();
                                            view.dispatch({
                                                changes: { from: selection.from, to: selection.to, insert: text },
                                                selection: { anchor: selection.from + text.length }
                                            });
                                            view.focus();
                                        }, assertInsertable);
                                        return true;
                                    }
                                }
                            }
                        }
                        return false;
                    },
                    mousedown: (e, view) => {
                        clearEmbeddedVisualMove(view);
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
                    ".cm-content": { caretColor: "var(--color-accent)", padding: "0", color: "var(--color-primary) !important", fontFamily: "var(--font-sans) !important" },
                    ".cm-cursor, .cm-dropCursor": { borderLeftWidth: "2px !important", borderLeftColor: "var(--color-accent) !important" },
                    "&.cm-embedded-object-selected .cm-cursor": { display: "none !important" },
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
                        zIndex: "9999"
                    },
                    ".cm-scroller": {
                        overflow: "visible !important"
                    }
                })
            ];
        const cachedState = stateCacheKey ? editorStateCache.get(stateCacheKey) : undefined;
        let state: EditorState;
        if (cachedState?.doc === content) {
            try {
                state = EditorState.fromJSON(cachedState.json, { extensions }, { history: historyField });
                editorStateCache.delete(stateCacheKey!);
                editorStateCache.set(stateCacheKey!, { ...cachedState, group: stateCacheGroupRef.current });
            } catch {
                editorStateCache.delete(stateCacheKey!);
                state = EditorState.create({ doc: content, extensions });
            }
        } else {
            state = EditorState.create({ doc: content, extensions });
        }

        const view = new EditorView({
            state,
            parent: containerRef.current
        });

        viewRef.current = view;
        view.requestMeasure();
        requestAnimationFrame(() => {
            if (view.dom.isConnected) onReadyRef.current?.(view);
        });
        registerEditorBoundaryHandlers(view, {
            isEmbedded: Boolean(onEscRef.current),
            onUp: x => { onUpRef.current?.(x); },
            onDown: x => { onDownRef.current?.(x); }
        });

        return () => {
            unregisterEditorBoundaryHandlers(view);
            if (stateCacheKey) rememberEditorState(stateCacheKey, view.state, stateCacheGroupRef.current);
            view.destroy();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []); 

    useLayoutEffect(() => {
        if (!viewRef.current) return;
        viewRef.current.dispatch({
            effects: [readOnlyCompartmentRef.current.reconfigure([
                EditorState.readOnly.of(!!isReadOnly),
                EditorView.editable.of(!isReadOnly)
            ]), setEditorFocus.of(!isReadOnly && isFocused), ...(!isReadOnly ? [clearTransientEmbeddedOpen.of(null)] : [])]
        });
        if (isReadOnly && viewRef.current.hasFocus) viewRef.current.contentDOM.blur();
    }, [isReadOnly, isDormant]);

    useEffect(() => {
        let focusRetryFrame: number | null = null;
        if (viewRef.current) {
            viewRef.current.dispatch({ effects: setEditorFocus.of(!isReadOnly && isFocused) });
        }

        const isDOMFocused = viewRef.current ? (
            viewRef.current.hasFocus || 
            (containerRef.current ? containerRef.current.contains(document.activeElement) : false)
        ) : false;

        if (!isReadOnly && isFocused && !isDormant && viewRef.current) {
            const editorView = viewRef.current;
            let forwardedToFinalEmbed = false;
            if (!isDOMFocused && (focusDirection === "end" || focusDirection === "start")) {
                const edge = focusDirection === "end" ? editorView.state.doc.length : 0;
                let anchor = edge;
                if (typeof focusX === "number") {
                    const edgeCoords = editorView.coordsAtPos(edge, focusDirection === "end" ? -1 : 1);
                    if (edgeCoords) {
                        const mapped = editorView.posAtCoords({
                            x: focusX,
                            y: (edgeCoords.top + edgeCoords.bottom) / 2
                        }, false);
                        // Choose the requested edge row first, then preserve the
                        // horizontal goal inside that row. Without the clamp, a
                        // short first/last text row followed by a wide block-math
                        // widget can make posAtCoords jump into the formula.
                        const edgeLine = focusDirection === "start"
                            ? editorView.state.doc.line(1)
                            : editorView.state.doc.line(editorView.state.doc.lines);
                        anchor = Math.max(edgeLine.from, Math.min(edgeLine.to, mapped));
                    }
                }
                editorView.dispatch({ selection: { anchor } });
                if (focusDirection === "end") {
                    forwardedToFinalEmbed = enterOpenEmbeddedAtEnd(editorView, focusX ?? undefined);
                }
            }

            if (!isDOMFocused && !forwardedToFinalEmbed) {
                isProgrammaticFocusRef.current = true;
                // Preserve the panel position while the static surface hydrates.
                // CodeMirror receives the already-computed selection without
                // asking the browser to scroll the new contenteditable node.
                editorView.contentDOM.focus({ preventScroll: true });
                // Moving through several embedded boundaries can reconcile a
                // parent widget in the same frame after the deepest editor has
                // focused. Retry once after that DOM settles. The effect
                // cleanup cancels this when the requested destination changes,
                // so a stale editor cannot steal focus back.
                focusRetryFrame = requestAnimationFrame(() => {
                    focusRetryFrame = null;
                    if (viewRef.current === editorView && editorView.dom.isConnected && !editorView.hasFocus) {
                        editorView.contentDOM.focus({ preventScroll: true });
                        if (!editorView.hasFocus) {
                            focusRetryFrame = requestAnimationFrame(() => {
                                focusRetryFrame = null;
                                if (viewRef.current === editorView && editorView.dom.isConnected && !editorView.hasFocus) {
                                    editorView.contentDOM.focus({ preventScroll: true });
                                }
                            });
                        }
                    }
                });
            }
        }
        return () => {
            if (focusRetryFrame !== null) cancelAnimationFrame(focusRetryFrame);
        };
    }, [isReadOnly, isFocused, isDormant, focusDirection, focusX, focusRequestKey]);

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
            if (JSON.stringify(occurrencePath) !== JSON.stringify(occurrencePathRef.current)) {
                occurrencePathRef.current = occurrencePath;
                effects.push(occurrencePathCompartmentRef.current.reconfigure(occurrencePathFacet.of(occurrencePath || [])));
            }
            if (JSON.stringify(macros) !== JSON.stringify(macrosRef.current)) {
                macrosRef.current = macros;
                effects.push(macrosCompartmentRef.current.reconfigure(livePreviewMacros.of(macros)));
            }
            if (effects.length > 0) {
                viewRef.current.dispatch({ effects });
            }
        }
    }, [parentLabel, visitedLabels, occurrencePath, macros]);

    return <div
        ref={containerRef}
        className="w-full"
        data-editor-dormant={isDormant ? "true" : "false"}
        data-editor-read-only={isReadOnly ? "true" : "false"}
        data-editor-wants-focus={isFocused ? "true" : "false"}
    />;
}
