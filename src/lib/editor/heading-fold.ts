import { markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view';
import { codeFolding, foldEffect, foldService, foldedRanges, syntaxTree, unfoldEffect } from '@codemirror/language';

const headingName = /^ATXHeading([1-6])$/;

function headingFoldRange(state: EditorState, lineStart: number, lineEnd: number) {
    const headings: { from: number; level: number }[] = [];
    markdownLanguage.parser.parse(state.doc.toString()).iterate({ enter(node) {
        const match = headingName.exec(node.name);
        if (match) headings.push({ from: node.from, level: Number(match[1]) });
    } });
    const index = headings.findIndex(heading => heading.from === lineStart);
    if (index < 0) return null;
    const next = headings.slice(index + 1).find(heading => heading.level <= headings[index].level);
    // Leave the newline before the next peer heading visible so it stays on
    // its own line after CodeMirror inserts the fold placeholder.
    const to = next ? next.from - 1 : state.doc.length;
    return to > lineEnd + 1 ? { from: lineEnd, to } : null;
}

export function unfoldHeadingAncestors(view: EditorView, position: number) {
    const effects: ReturnType<typeof unfoldEffect.of>[] = [];
    foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => {
        if (from < position && position < to) effects.push(unfoldEffect.of({ from, to }));
    });
    if (effects.length) view.dispatch({ effects });
}

function isFolded(state: EditorState, from: number) {
    let found = false;
    foldedRanges(state).between(from, from + 1, start => { if (start === from) found = true; });
    return found;
}

class HeadingFoldWidget extends WidgetType {
    constructor(readonly lineFrom: number, readonly folded: boolean) { super(); }
    eq(other: WidgetType) { return other instanceof HeadingFoldWidget && other.lineFrom === this.lineFrom && other.folded === this.folded; }
    toDOM(view: EditorView) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'cm-heading-fold-toggle';
        button.dataset.folded = String(this.folded);
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('viewBox', '0 0 24 24');
        icon.setAttribute('aria-hidden', 'true');
        icon.classList.add('cm-heading-fold-chevron');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'm9 18 6-6-6-6');
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', 'currentColor');
        path.setAttribute('stroke-width', '2.5');
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('stroke-linejoin', 'round');
        icon.append(path);
        button.append(icon);
        button.setAttribute('aria-label', this.folded ? 'Expand heading section' : 'Collapse heading section');
        button.title = this.folded ? 'Expand heading section' : 'Collapse heading section';
        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            const line = view.state.doc.lineAt(Math.min(this.lineFrom, view.state.doc.length));
            const range = headingFoldRange(view.state, line.from, line.to);
            if (!range) return;
            view.dispatch({ effects: (isFolded(view.state, range.from) ? unfoldEffect : foldEffect).of(range) });
        });
        return button;
    }
    ignoreEvent() { return true; }
}

function headingFoldDecorations(view: EditorView): DecorationSet {
    const decorations = [];
    syntaxTree(view.state).iterate({ from: view.viewport.from, to: view.viewport.to, enter(node) {
        if (!headingName.test(node.name)) return;
        const line = view.state.doc.lineAt(node.from);
        if (line.to >= view.state.doc.length) return;
        const folded = isFolded(view.state, line.to);
        if (folded) {
            decorations.push(Decoration.line({ class: 'cm-heading-folded-line' }).range(line.from));
        }
        decorations.push(Decoration.widget({
            widget: new HeadingFoldWidget(line.from, folded),
            side: -1
        }).range(line.from));
    } });
    return Decoration.set(decorations, true);
}

const headingFoldControls = ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = headingFoldDecorations(view); }
    update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged ||
            foldedRanges(update.startState) !== foldedRanges(update.state)) {
            this.decorations = headingFoldDecorations(update.view);
        }
    }
}, { decorations: plugin => plugin.decorations });

export const headingFolding = [
    foldService.of(headingFoldRange),
    codeFolding({
        placeholderDOM: (_view, onclick) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'cm-heading-fold-placeholder';
            button.textContent = '...';
            button.title = 'Expand section';
            button.setAttribute('aria-label', 'Expand heading section');
            button.addEventListener('click', onclick);
            return button;
        }
    }),
    headingFoldControls
];
