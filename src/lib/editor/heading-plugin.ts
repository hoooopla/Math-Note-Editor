import { syntaxTree } from '@codemirror/language';
import { EditorView, Decoration, DecorationSet, ViewPlugin, ViewUpdate } from '@codemirror/view';

const headingName = /^ATXHeading([1-6])$/;

function headingAt(view: EditorView, position: number) {
    let result: { markerFrom: number; contentFrom: number } | undefined;
    syntaxTree(view.state).iterate({ from: position, to: position + 1, enter(node) {
        if (!headingName.test(node.name) || position < node.from || position > node.to) return;
        const marker = node.node.getChildren('HeaderMark')[0];
        if (!marker) return;
        const line = view.state.doc.lineAt(marker.from);
        let contentFrom = marker.to;
        while (contentFrom < line.to && /[ \t]/.test(view.state.doc.sliceString(contentFrom, contentFrom + 1))) contentFrom++;
        result = { markerFrom: marker.from, contentFrom };
    } });
    return result;
}

/** A single Backspace at the start of heading text converts it to plain text. */
export function removeHeadingPrefix(view: EditorView) {
    const selection = view.state.selection.main;
    if (!selection.empty || view.state.readOnly) return false;
    const heading = headingAt(view, selection.head);
    if (!heading || selection.head !== heading.contentFrom) return false;
    view.dispatch({
        changes: { from: heading.markerFrom, to: heading.contentFrom },
        selection: { anchor: heading.markerFrom },
        scrollIntoView: true,
        userEvent: 'delete.backward'
    });
    return true;
}

function headingDecorations(view: EditorView): DecorationSet {
    const decorations = [];
    const { state } = view;
    const selection = state.selection.main;
    syntaxTree(state).iterate({ from: view.viewport.from, to: view.viewport.to, enter(node) {
        const match = headingName.exec(node.name);
        if (!match) return;
        const line = state.doc.lineAt(node.from);
        const markers = node.node.getChildren('HeaderMark');
        if (!markers.length) return;
        decorations.push(Decoration.line({ class: `cm-heading-line cm-heading-level-${match[1]}` }).range(line.from));
        const active = !state.readOnly && view.hasFocus && selection.from <= line.to && selection.to >= line.from;
        const first = markers[0];
        let contentFrom = first.to;
        while (contentFrom < line.to && /[ \t]/.test(state.doc.sliceString(contentFrom, contentFrom + 1))) contentFrom++;
        if (active) {
            decorations.push(Decoration.mark({ class: 'cm-heading-marker' }).range(first.from, first.to));
        } else {
            decorations.push(Decoration.replace({}).range(first.from, contentFrom));
        }
        for (const marker of markers.slice(1)) {
            decorations.push(active
                ? Decoration.mark({ class: 'cm-heading-marker' }).range(marker.from, marker.to)
                : Decoration.replace({}).range(marker.from, marker.to));
        }
    } });
    return Decoration.set(decorations, true);
}

export const headingPlugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
        this.decorations = headingDecorations(view);
    }

    update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged ||
            update.startState.readOnly !== update.state.readOnly) {
            this.decorations = headingDecorations(update.view);
        }
    }
}, { decorations: plugin => plugin.decorations });
