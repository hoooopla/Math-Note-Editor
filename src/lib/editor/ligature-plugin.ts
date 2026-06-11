import { Decoration, DecorationSet, MatchDecorator, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";

const ligatureDecoration = Decoration.mark({
    class: "cm-ligature"
});

const ligatureMatcher = new MatchDecorator({
    regexp: /(~>|<=>|!=|=>|<=|\\\/)/g,
    decoration: ligatureDecoration
});

export const ligaturePlugin = ViewPlugin.fromClass(class {
    ligatures: DecorationSet;

    constructor(view: EditorView) {
        this.ligatures = ligatureMatcher.createDeco(view);
    }

    update(update: ViewUpdate) {
        this.ligatures = ligatureMatcher.updateDeco(update, this.ligatures);
    }
}, {
    decorations: instance => instance.ligatures
});
