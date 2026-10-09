import { ViewPlugin, DecorationSet, EditorView, WidgetType, ViewUpdate, Decoration } from "@codemirror/view";
import { StateEffect } from "@codemirror/state";
import { useStore } from "../../store";
import { scanImageReferences } from "../asset-reference";
import { syntaxTree } from '@codemirror/language';
import { ImageGeometry, validImageGeometry } from '../image-geometry';
import { acquireImageUrl, imageWorkspaceEpoch, knownImageGeometry, rememberImageGeometry } from './image-resources';

class ImageWidget extends WidgetType {
    private releaseResource: (() => void) | null = null;
    private disposed = false;

    constructor(readonly src: string, readonly width: string, readonly revision: number,
        readonly from: number, readonly to: number, readonly geometry: ImageGeometry | null,
        readonly isReadOnly: boolean) {
        super();
    }

    eq(other: ImageWidget) {
        return other.src === this.src && other.width === this.width && other.revision === this.revision
            && other.from === this.from && other.to === this.to
            && other.isReadOnly === this.isReadOnly
            && other.geometry?.width === this.geometry?.width && other.geometry?.height === this.geometry?.height;
    }

    toDOM(view: EditorView) {
        const span = document.createElement("span");
        span.className = "cm-image-widget";
        span.title = this.isReadOnly ? this.src : "Click to edit image source";
        span.style.cursor = this.isReadOnly ? "default" : "text";
        span.addEventListener('pointerdown', event => {
            if (event.button !== 0 || !view.dom.isConnected || view.state.readOnly) return;
            event.preventDefault();
            event.stopPropagation();
            // The selection intersects the replaced range, so the next decoration
            // pass exposes the exact Markdown/HTML source at this position.
            view.dispatch({ selection: { anchor: Math.min(this.from + 1, this.to) } });
            view.contentDOM.focus({ preventScroll: true });
        });
        span.style.display = "inline-block";
        span.style.verticalAlign = "top";
        span.style.maxWidth = "100%";
        
        const img = document.createElement("img");
        const epoch = imageWorkspaceEpoch();
        const applyGeometry = (geometry: ImageGeometry) => {
            const checked = validImageGeometry(geometry.width, geometry.height);
            if (!checked) return;
            const explicitWidth = /^\d{1,5}$/.test(this.width) ? `${this.width}px`
                : /^\d{1,5}(?:\.\d+)?(?:px|%)$/.test(this.width) ? this.width : null;
            span.style.width = explicitWidth || `${checked.width}px`;
            img.style.width = '100%';
            img.style.height = 'auto';
            img.style.aspectRatio = `${checked.width} / ${checked.height}`;
            img.dataset.imageReserved = 'true';
        };
        const initialGeometry = knownImageGeometry(this.src) || this.geometry;
        const fallback = document.createElement("span");
        fallback.hidden = true;
        fallback.className = "max-w-full break-all rounded border border-red-400/40 bg-red-400/10 px-2 py-1 text-sm text-red-300";
        fallback.style.display = "none";
        fallback.textContent = `Image unavailable: ${this.src}`;
        fallback.title = this.src;
        const showError = () => {
            if (this.disposed) return;
            img.style.display = "none";
            span.style.removeProperty('width');
            delete img.dataset.imageReserved;
            img.dataset.imageFailed = 'true';
            fallback.hidden = false;
            fallback.style.display = "inline-block";
        };
        img.onerror = showError;
        img.onload = () => {
            if (this.disposed) return;
            const actual = validImageGeometry(img.naturalWidth, img.naturalHeight);
            if (!actual) return;
            rememberImageGeometry(this.src, actual, epoch);
            applyGeometry(actual);
        };
        // Image widgets are created inside the three-screen CodeMirror render
        // window. Eager asynchronous decoding lets the browser finish the
        // actual image before it reaches the visible viewport without blocking
        // editor input.
        img.loading = "eager";
        img.decoding = "async";
        
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
        if (initialGeometry) applyGeometry(initialGeometry);

        span.appendChild(img);
        span.appendChild(fallback);
        if (this.src.startsWith("http://") || this.src.startsWith("https://") || this.src.startsWith("data:") || this.src.startsWith("blob:")) {
            img.src = this.src;
        } else {
            const lease = acquireImageUrl(this.src, this.revision, () => useStore.getState().getAssetUrl(this.src));
            this.releaseResource = lease.release;
            lease.promise.then(url => {
                if (this.disposed) return;
                img.src = url.startsWith('/api/assets/')
                    ? `${url}${url.includes('?') ? '&' : '?'}v=${this.revision}` : url;
            }).catch(showError);
        }
        return span;
    }

    ignoreEvent() { return true; }

    destroy() {
        this.disposed = true;
        this.releaseResource?.();
        this.releaseResource = null;
    }
}

const refreshImages = StateEffect.define<null>();

function buildImageDecorations(view: EditorView) {
    const decos: {from: number, to: number, deco: Decoration}[] = [];
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
        for (const match of scanImageReferences(text)) {
            const start = window.from + match.from;
            const end = window.from + match.to;
            let syntaxNode = syntaxTree(view.state).resolveInner(start, 1);
            let inCode = false;
            while (syntaxNode) {
                if (syntaxNode.name === 'InlineCode' || syntaxNode.name === 'FencedCode' || syntaxNode.name === 'CodeBlock') {
                    inCode = true;
                    break;
                }
                syntaxNode = syntaxNode.parent;
            }
            if (inCode) continue;
            const src = match.src;
            const width = match.width;
            const hasSelectionInside = !view.state.readOnly && selection.from <= end && selection.to >= start;

            if (!hasSelectionInside) {
                decos.push({
                    from: start,
                    to: end,
                    deco: Decoration.replace({
                        widget: new ImageWidget(src, width, useStore.getState().assetRevision, start, end,
                            match.geometry || null, view.state.readOnly)
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
    private unsubscribe: () => void;
    constructor(view: EditorView) {
        this.decorations = buildImageDecorations(view);
        this.unsubscribe = useStore.subscribe((state, previous) => {
            if (state.assetRevision !== previous.assetRevision && view.dom.isConnected) {
                view.dispatch({ effects: refreshImages.of(null) });
            }
        });
    }
    update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet || update.focusChanged || update.viewportChanged ||
            update.startState.readOnly !== update.state.readOnly ||
            update.transactions.some(transaction => transaction.effects.some(effect => effect.is(refreshImages)))) {
            this.decorations = buildImageDecorations(update.view);
        }
    }
    destroy() { this.unsubscribe(); }
}, {
    decorations: v => v.decorations
});
