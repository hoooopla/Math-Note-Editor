import { ViewPlugin, DecorationSet, EditorView, WidgetType, ViewUpdate, Decoration } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { useStore } from "../../store";

class ImageWidget extends WidgetType {
    private objectUrl: string | null = null;
    private disposed = false;

    constructor(readonly src: string, readonly width: string) {
        super();
    }

    eq(other: ImageWidget) {
        return other.src === this.src && other.width === this.width;
    }

    toDOM(view: EditorView) {
        const span = document.createElement("span");
        span.className = "cm-image-widget";
        span.style.display = "inline-block";
        span.style.verticalAlign = "top";
        span.style.maxWidth = "100%";
        
        const img = document.createElement("img");
        
        if (this.src.startsWith("http://") || this.src.startsWith("https://") || this.src.startsWith("data:") || this.src.startsWith("blob:")) {
            img.src = this.src;
        } else {
            useStore.getState().getAssetUrl(this.src).then(url => {
                if (url.startsWith("blob:")) {
                    if (this.disposed) {
                        URL.revokeObjectURL(url);
                        return;
                    }
                    this.objectUrl = url;
                }
                img.src = url;
            }).catch(() => { img.src = this.src; });
        }

        if (this.width) {
            if (this.width.endsWith('%') || this.width.endsWith('px')) {
                img.style.width = this.width;
            } else {
                img.setAttribute("width", this.width);
            }
        }
        img.style.maxWidth = "100%";
        img.style.maxHeight = "600px";
        img.style.objectFit = "contain";
        img.style.marginTop = "0.5rem";
        img.style.marginBottom = "0.5rem";
        img.style.borderRadius = "0.5rem";
        img.style.display = "block"; // img can be block inside inline-block

        span.appendChild(img);
        return span;
    }

    ignoreEvent() { return true; }

    destroy() {
        this.disposed = true;
        if (this.objectUrl) {
            URL.revokeObjectURL(this.objectUrl);
            this.objectUrl = null;
        }
    }
}

function buildImageDecorations(view: EditorView) {
    const decos: {from: number, to: number, deco: Decoration}[] = [];
    const regex = /<img\s+[^>]*src="([^"]+)"(?:[^>]*width="([^"]+)")?[^>]*\s*\/?>|!\[.*?\]\((.*?)\)/g;
    const doc = view.state.doc;
    const selection = view.state.selection.main;
    const windows = [...view.visibleRanges, { from: selection.from, to: selection.to }]
        .map(range => {
            const firstLine = doc.lineAt(Math.max(0, range.from));
            const lastLine = doc.lineAt(Math.min(doc.length, range.to));
            return {
                from: firstLine.number > 1 ? doc.line(firstLine.number - 1).from : firstLine.from,
                to: lastLine.number < doc.lines ? doc.line(lastLine.number + 1).to : lastLine.to
            };
        })
        .sort((a, b) => a.from - b.from)
        .reduce<{from: number, to: number}[]>((merged, current) => {
            const previous = merged[merged.length - 1];
            if (previous && current.from <= previous.to) previous.to = Math.max(previous.to, current.to);
            else merged.push({ ...current });
            return merged;
        }, []);

    for (const window of windows) {
        const text = doc.sliceString(window.from, window.to);
        regex.lastIndex = 0;
        let match;
        while ((match = regex.exec(text)) !== null) {
            const start = window.from + match.index;
            const end = start + match[0].length;
            const src = match[1] || match[3];
            const width = match[2] || "";
            const hasSelectionInside = selection.from <= end && selection.to >= start;

            if (!hasSelectionInside) {
                decos.push({
                    from: start,
                    to: end,
                    deco: Decoration.replace({
                        widget: new ImageWidget(src, width)
                    })
                });
            }
        }
    }
    
    decos.sort((a,b) => a.from - b.from);
    return Decoration.set(decos.map(d => d.deco.range(d.from, d.to)), true);
}

export const imagePlugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
        this.decorations = buildImageDecorations(view);
    }
    update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet || update.focusChanged || update.viewportChanged) {
            this.decorations = buildImageDecorations(update.view);
        }
    }
}, {
    decorations: v => v.decorations
});
