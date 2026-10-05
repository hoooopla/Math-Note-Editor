import { EditorView } from "@codemirror/view";
import { getEmbeddedPanelUserIntentVersion, setEmbeddedPanelScrollTop } from "../embedded-scroll-coordinator";

const pendingRevealByPanel = new WeakMap<HTMLElement, number>();
let nextRevealId = 0;

/** One reveal for the final caret, after native movement or an editor handoff. */
export function scheduleFinalCaretReveal(origin: EditorView, readProjection: (view: EditorView) => {
    titleSelected: boolean; atInlineSuffix: boolean;
}) {
    const panel = origin.dom.closest<HTMLElement>('[role="tabpanel"]');
    if (!panel) return;
    const requestId = ++nextRevealId;
    const intentVersion = getEmbeddedPanelUserIntentVersion(panel);
    pendingRevealByPanel.set(panel, requestId);
    const deadline = performance.now() + 2000;
    let previousGeometry = '';
    let stableFrames = 0;
    let waitedForLoading = false;
    let destination: { view: EditorView; selection: typeof origin.state.selection } | null = null;

    const reveal = (attempt: number) => {
        if (!panel.isConnected || pendingRevealByPanel.get(panel) !== requestId ||
            getEmbeddedPanelUserIntentVersion(panel) !== intentVersion) return;
        const focusedElement = document.activeElement;
        const editorElement = focusedElement instanceof HTMLElement
            ? focusedElement.closest<HTMLElement>(".cm-editor")
            : null;
        const view = editorElement && panel.contains(editorElement)
            ? EditorView.findFromDOM(editorElement)
            : null;
        if (!view?.hasFocus) {
            if (performance.now() < deadline) requestAnimationFrame(() => reveal(attempt + 1));
            return;
        }
        if (destination && (destination.view !== view || !destination.selection.eq(view.state.selection))) return;
        destination ??= { view, selection: view.state.selection };

        const projectedCaret = Array.from(view.dom.querySelectorAll<HTMLElement>(
            '[data-embed-keyboard-selected="true"] [data-testid="embedded-title-caret"]'
        )).find(element => element.closest(".cm-editor") === view.dom);
        const selection = view.state.selection.main;
        const projection = readProjection(view);
        const titleSelection = projection.titleSelected;
        const selectedTitle = titleSelection ? Array.from(view.dom.querySelectorAll<HTMLElement>(
            '[data-embed-keyboard-selected="true"]'
        )).find(element => element.closest(".cm-editor") === view.dom) : null;
        // The source endpoint of an expanded title can sit below its entire
        // body. Never reveal that hidden endpoint while React is mounting the
        // projected title caret.
        if (titleSelection && !projectedCaret && !selectedTitle) {
            if (performance.now() < deadline) requestAnimationFrame(() => reveal(attempt + 1));
            return;
        }
        const caret = projectedCaret?.getBoundingClientRect() ??
            selectedTitle?.getBoundingClientRect() ??
            view.coordsAtPos(selection.head, selection.assoc < 0 ? -1 : 1);
        const viewport = panel.getBoundingClientRect();
        if (!caret) {
            if (performance.now() < deadline) requestAnimationFrame(() => reveal(attempt + 1));
            return;
        }
        // A suffix can already have coordinates while its preceding body is
        // still a loading placeholder. Resolve against the final destination,
        // not that temporary short geometry. Native layout scrolls must not
        // cancel this intent; any subsequent explicit input still does.
        const loadingBeforeCaret = !titleSelection && Array.from(view.dom.querySelectorAll<HTMLElement>(
            '.cm-embedded-block-wrapper[data-embed-part="body"]'
        )).some(wrapper => wrapper.closest('.cm-editor') === view.dom &&
            Number(wrapper.dataset.embedTo) <= selection.head &&
            Array.from(wrapper.querySelectorAll<HTMLElement>('[data-editor-mounted="true"]')).some(host =>
                !Array.from(host.querySelectorAll('.cm-editor')).some(editor =>
                    editor.closest('[data-editor-mounted="true"]') === host)));
        const geometry = `${Math.round((caret.top + panel.scrollTop) * 2)}:${Math.round((caret.bottom + panel.scrollTop) * 2)}:${panel.clientHeight}`;
        stableFrames = geometry === previousGeometry ? stableFrames + 1 : 0;
        previousGeometry = geometry;
        waitedForLoading ||= loadingBeforeCaret;
        const atInlineSuffix = projection.atInlineSuffix;
        if ((loadingBeforeCaret || ((waitedForLoading || atInlineSuffix) && stableFrames < 2)) && performance.now() < deadline) {
            view.requestMeasure();
            requestAnimationFrame(() => reveal(attempt + 1));
            return;
        }
        const top = viewport.top + 8;
        const bottom = viewport.bottom - 8;
        const delta = caret.top < top ? caret.top - top : caret.bottom > bottom ? caret.bottom - bottom : 0;
        if (delta) setEmbeddedPanelScrollTop(panel, panel.scrollTop + delta);
    };
    requestAnimationFrame(() => reveal(0));
}
