import { EditorState, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';

export type FindHighlight = { from: number; to: number };

export const setFindHighlight = StateEffect.define<FindHighlight | null>();

export const findHighlightField = StateField.define<FindHighlight | null>({
    create: () => null,
    update(value, transaction) {
        if (transaction.docChanged && value) {
            const from = transaction.changes.mapPos(value.from, -1);
            const to = transaction.changes.mapPos(value.to, 1);
            value = from < to ? { from, to } : null;
        }
        for (const effect of transaction.effects) if (effect.is(setFindHighlight)) value = effect.value;
        return value;
    },
    provide: field => EditorView.decorations.compute([field], state => {
        const match = state.field(field);
        return match && match.from >= 0 && match.to <= state.doc.length && match.from < match.to
            ? Decoration.set([Decoration.mark({ class: 'cm-find-exact-match' }).range(match.from, match.to)])
            : Decoration.none;
    })
});

export function findHighlightOverlaps(state: EditorState, from: number, to: number) {
    const match = state.field(findHighlightField, false);
    return !!match && match.from < to && match.to > from;
}
