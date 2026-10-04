import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { getEmbeddedPanelScrollVersion, setEmbeddedPanelScrollTop } from "../embedded-scroll-coordinator";
import { embeddedObjectSelectionField, parsedLinksField, runEmbeddedKey } from "./embedded-block-plugin";
import { parsedRangesField, setEditorFocus } from "./katex-plugin";

export type VerticalDirection = "up" | "down";

const pendingRevealByPanel = new WeakMap<HTMLElement, number>();
let nextRevealId = 0;

/** One reveal for the final caret, after native movement or an editor handoff. */
export function scheduleFinalNavigationReveal(origin: EditorView) {
    const panel = origin.dom.closest<HTMLElement>('[role="tabpanel"]');
    if (!panel) return;
    const requestId = ++nextRevealId;
    const scrollVersion = getEmbeddedPanelScrollVersion(panel);
    pendingRevealByPanel.set(panel, requestId);

    const reveal = (attempt: number) => {
        if (pendingRevealByPanel.get(panel) !== requestId ||
            getEmbeddedPanelScrollVersion(panel) !== scrollVersion) return;
        const focusedElement = document.activeElement;
        const editorElement = focusedElement instanceof HTMLElement
            ? focusedElement.closest<HTMLElement>(".cm-editor")
            : null;
        const view = editorElement && panel.contains(editorElement)
            ? EditorView.findFromDOM(editorElement)
            : null;
        if (!view?.hasFocus) {
            if (attempt < 3) requestAnimationFrame(() => reveal(attempt + 1));
            return;
        }

        const projectedCaret = Array.from(view.dom.querySelectorAll<HTMLElement>(
            '[data-embed-keyboard-selected="true"] [data-testid="embedded-title-caret"]'
        )).find(element => element.closest(".cm-editor") === view.dom);
        const selection = view.state.selection.main;
        const titleSelection = view.state.field(embeddedObjectSelectionField, false);
        const selectedTitle = titleSelection && Array.from(view.dom.querySelectorAll<HTMLElement>(
            '[data-embed-keyboard-selected="true"]'
        )).find(element => element.closest(".cm-editor") === view.dom);
        // The source endpoint of an expanded title can sit below its entire
        // body. Never reveal that hidden endpoint while React is mounting the
        // projected title caret.
        if (titleSelection && !projectedCaret && !selectedTitle) {
            if (attempt < 3) requestAnimationFrame(() => reveal(attempt + 1));
            return;
        }
        const caret = projectedCaret?.getBoundingClientRect() ??
            selectedTitle?.getBoundingClientRect() ??
            view.coordsAtPos(selection.head, selection.assoc < 0 ? -1 : 1);
        const viewport = panel.getBoundingClientRect();
        if (!caret) return;
        const top = viewport.top + 8;
        const bottom = viewport.bottom - 8;
        const delta = caret.top < top ? caret.top - top : caret.bottom > bottom ? caret.bottom - bottom : 0;
        if (delta) setEmbeddedPanelScrollTop(panel, panel.scrollTop + delta);
    };
    requestAnimationFrame(() => reveal(0));
}

function ownedMathWidget(view: EditorView, from: number, to: number) {
    return Array.from(view.contentDOM.querySelectorAll<HTMLElement>(".cm-math-block"))
        .find(element => {
            if (element.closest(".cm-editor") !== view.dom) return false;
            try {
                const position = view.posAtDOM(element);
                return position >= from && position <= to;
            } catch {
                return false;
            }
        });
}

/** Display math participates in the same nearest-visible-row decision as text and embeds. */
function enterAdjacentDisplayMath(view: EditorView, direction: VerticalDirection) {
    const selection = view.state.selection.main;
    if (!view.hasFocus || !selection.empty) return false;
    const ranges = view.state.field(parsedRangesField, false);
    if (!ranges) return false;

    const forward = direction === "down";
    const currentLine = view.state.doc.lineAt(selection.head);
    const adjacentNumber = currentLine.number + (forward ? 1 : -1);
    if (adjacentNumber < 1 || adjacentNumber > view.state.doc.lines) return false;
    const adjacentLine = view.state.doc.line(adjacentNumber);
    const math = ranges.find(range => range.type === "blockMath" &&
        range.from <= adjacentLine.to && range.to >= adjacentLine.from &&
        (forward ? selection.head < range.from : selection.head > range.to));
    if (!math) return false;

    const links = view.state.field(parsedLinksField);
    // Down from an expanded title enters its body, even if the following
    // Markdown line happens to be display math.
    const selectedTitle = view.state.field(embeddedObjectSelectionField, false);
    if (forward && selectedTitle && links.some(link =>
        link.open && link.from === selectedTitle.from && link.to === selectedTitle.to
    )) return false;
    // Source adjacency is insufficient when an embedded title/body splits the
    // current source line. These occurrences precede the equation visually,
    // including when the equation itself is outside CodeMirror's viewport.
    if (!selectedTitle && links.some(link =>
        link.from >= currentLine.from && link.to <= currentLine.to &&
        (forward ? link.from >= selection.head : link.open && link.to <= selection.head)
    )) return false;

    const side = forward ? 1 : -1;
    const current = view.coordsAtPos(selection.head, side);
    const widget = ownedMathWidget(view, math.from, math.to);
    const widgetRect = widget?.getBoundingClientRect();
    const mathEdge = widgetRect ? (forward ? widgetRect.top : widgetRect.bottom) : null;
    const currentEdge = current ? (forward ? current.bottom : current.top) : null;

    // A wrapped row or an embedded portal may lie between the caret and the
    // equation, despite the equation being on the next Markdown source line.
    if (mathEdge !== null && currentEdge !== null) {
        if (forward ? mathEdge < currentEdge - 2 : mathEdge > currentEdge + 2) return false;
        const native = view.moveVertically(selection, forward);
        if (native.head !== selection.head &&
            view.state.doc.lineAt(native.head).number === currentLine.number) {
            const nativeRect = view.coordsAtPos(native.head, native.assoc || side);
            if (nativeRect) {
                const nativeEdge = forward ? nativeRect.top : nativeRect.bottom;
                if (forward
                    ? nativeEdge > currentEdge + 2 && nativeEdge < mathEdge - 2
                    : nativeEdge < currentEdge - 2 && nativeEdge > mathEdge + 2) return false;
            }
        }
        for (const element of view.contentDOM.querySelectorAll<HTMLElement>(
            "[data-embed-nav-title], [data-embed-nav-body]"
        )) {
            if (element.closest(".cm-editor") !== view.dom) continue;
            const rect = element.getBoundingClientRect();
            const edge = forward ? rect.top : rect.bottom;
            if (forward ? edge > currentEdge + 2 && edge < mathEdge - 2
                : edge < currentEdge - 2 && edge > mathEdge + 2) return false;
        }
    }

    view.dispatch({
        selection: EditorSelection.cursor(forward ? math.from : math.to, side),
        effects: setEditorFocus.of(true)
    });
    return true;
}

export function runLogicalVerticalNavigation(view: EditorView, direction: VerticalDirection) {
    return enterAdjacentDisplayMath(view, direction) ||
        runEmbeddedKey(view, direction === "up" ? "ArrowUp" : "ArrowDown");
}
