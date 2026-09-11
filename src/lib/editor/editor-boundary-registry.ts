import type { EditorView } from "@codemirror/view";

interface EditorBoundaryHandlers {
    isEmbedded: boolean;
    onUp: (x?: number) => void;
    onDown: (x?: number) => void;
}

const editorBoundaryHandlers = new WeakMap<EditorView, EditorBoundaryHandlers>();

export function registerEditorBoundaryHandlers(view: EditorView, handlers: EditorBoundaryHandlers) {
    editorBoundaryHandlers.set(view, handlers);
}

export function unregisterEditorBoundaryHandlers(view: EditorView) {
    editorBoundaryHandlers.delete(view);
}

export function handOffEditorBoundary(
    view: EditorView,
    direction: "up" | "down",
    x?: number
) {
    const handlers = editorBoundaryHandlers.get(view);
    if (!handlers?.isEmbedded) return false;

    if (direction === "up") handlers.onUp(x);
    else handlers.onDown(x);
    return true;
}
