import { ViewPlugin, DecorationSet, EditorView, ViewUpdate, Decoration } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

function buildUrlDecorations(view: EditorView) {
    const decos: {from: number, to: number, deco: Decoration}[] = [];
    const doc = view.state.doc.toString();
    
    // Match raw urls
    const urlRegex = /https?:\/\/[^\s)\]">]+/g;
    let match;
    while ((match = urlRegex.exec(doc)) !== null) {
        decos.push({
            from: match.index,
            to: match.index + match[0].length,
            deco: Decoration.mark({
                tagName: "a",
                attributes: {
                    href: match[0],
                    target: "_blank",
                    rel: "noopener noreferrer",
                    style: "text-decoration: underline; cursor: pointer; color: #3b82f6;"
                }
            })
        });
    }

    // Match markdown links [text](url)
    // Avoid double creation of anchors if they overlap, but URL is separate
    // Wait, let's keep it simple and just make the raw urls clickable, or both.
    const mdRegex = /\[([^\]]+)\]\((https?:\/\/[^\s)\]">]+)\)/g;
    let mdMatch;
    while ((mdMatch = mdRegex.exec(doc)) !== null) {
        // We decorate the 'text' part too
        const start = mdMatch.index + 1; // after '['
        const end = start + mdMatch[1].length;
        const url = mdMatch[2];
        decos.push({
            from: start,
            to: end,
            deco: Decoration.mark({
                tagName: "a",
                attributes: {
                    href: url,
                    target: "_blank",
                    rel: "noopener noreferrer",
                    style: "text-decoration: underline; cursor: pointer; color: #3b82f6;"
                }
            })
        });
    }

    decos.sort((a,b) => a.from - b.from);
    
    const builder = new RangeSetBuilder<Decoration>();
    let lastEnd = 0;
    for (const d of decos) {
        if (d.from >= lastEnd) {
            builder.add(d.from, d.to, d.deco);
            lastEnd = d.to;
        }
    } // ignore overlapping matches
    
    return builder.finish();
}

export const urlPlugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
        this.decorations = buildUrlDecorations(view);
    }
    update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) {
            this.decorations = buildUrlDecorations(update.view);
        }
    }
}, {
    decorations: v => v.decorations
});
