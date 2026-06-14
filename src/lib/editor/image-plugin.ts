import { ViewPlugin, DecorationSet, EditorView, WidgetType, ViewUpdate, Decoration } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

class ImageWidget extends WidgetType {
    constructor(readonly src: string, readonly width: string) {
        super();
    }

    eq(other: ImageWidget) {
        return other.src === this.src && other.width === this.width;
    }

    toDOM(view: EditorView) {
        const span = document.createElement("span");
        span.className = "cm-image-widget";
        const img = document.createElement("img");
        img.src = this.src;
        if (this.width) {
            if (this.width.endsWith('%') || this.width.endsWith('px')) {
                img.style.width = this.width;
            } else {
                img.setAttribute("width", this.width);
            }
        }
        img.style.maxWidth = "100%";
        img.style.display = "block";
        img.style.marginTop = "0.5rem";
        img.style.marginBottom = "0.5rem";
        img.style.borderRadius = "0.5rem";

        const hasFocus = view.hasFocus;
        if (!hasFocus) {
            span.appendChild(img);
        } else {
            span.appendChild(img); // wait, if focus is inside? 
            // In CodeMirror, normally if we want to replace the text with widget, we do it. But users need to be able to edit the html tag text as well.
        }
        return span;
    }

    ignoreEvent() { return false; }
}

function buildImageDecorations(view: EditorView) {
    const builder = new RangeSetBuilder<Decoration>();
    const doc = view.state.doc.toString();
    const regex = /<img\s+[^>]*src="([^"]+)"(?:[^>]*width="([^"]+)")?[^>]*\s*\/?>/g;
    
    let match;
    while ((match = regex.exec(doc)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        const src = match[1];
        const width = match[2] || "";

        const selection = view.state.selection.main;
        const hasSelectionInside = selection.from <= end && selection.to >= start;

        if (!hasSelectionInside && !view.hasFocus) {
            builder.add(start, end, Decoration.replace({
                widget: new ImageWidget(src, width)
            }));
        } else if (!hasSelectionInside && view.hasFocus) {
            // Depending on preference, we could replace it or show as a line widget below.
            // But let's keep it simple: if editor is focused, we don't replace or we do it as block decorator?
            // Usually, if selection is not inside, it's nice to replace it even if editor is focused.
            builder.add(start, end, Decoration.replace({
                widget: new ImageWidget(src, width)
            }));
        }
    }
    return builder.finish();
}

export const imagePlugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
        this.decorations = buildImageDecorations(view);
    }
    update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet || update.focusChanged) {
            this.decorations = buildImageDecorations(update.view);
        }
    }
}, {
    decorations: v => v.decorations
});
