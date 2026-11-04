import { useMemo, useState, type ReactNode } from 'react';
import { EditorView } from '@codemirror/view';
import { ChevronDown, ChevronRight, Loader2, RotateCcw, SlidersHorizontal, X } from 'lucide-react';
import { useStore } from '../store';
import { buildContentOutline, OutlineNode } from '../lib/content-outline';
import { parseEmbeddedLinks } from '../lib/embedded-link-syntax';
import { MathTitle } from './MathTitle';

const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

async function findUntil<T>(find: () => T | null | undefined, frames = 90): Promise<T | null> {
    for (let i = 0; i < frames; i++) {
        const result = find();
        if (result) return result;
        await nextFrame();
    }
    return null;
}

function editorIn(element: Element): EditorView | null {
    const dom = element.querySelector<HTMLElement>('.cm-editor');
    return dom ? EditorView.findFromDOM(dom) : null;
}

async function navigate(rootId: string, node: OutlineNode): Promise<boolean> {
    const panel = document.getElementById(`block-tab-panel-${rootId}`);
    if (!panel) return false;
    let view = await findUntil(() => {
        const root = panel.querySelector<HTMLElement>('[data-block-root]');
        return root && editorIn(root);
    });
    if (!view) return false;
    const occurrencePath: string[] = [];
    for (const segment of node.path) {
        const target = useStore.getState().blocksById[segment.blockId];
        if (!target) return false;
        if (target.content === undefined) await useStore.getState().loadBlockContent(target.id);
        const link = parseEmbeddedLinks(view.state.doc.toString()).find(item => item.from === segment.from)
            || parseEmbeddedLinks(view.state.doc.toString()).find(item => item.from >= segment.from - 2 && item.from <= segment.from + 2);
        if (!link) return false;
        view.dispatch({ effects: EditorView.scrollIntoView(link.from, { y: 'center' }) });
        const title = await findUntil(() => view!.dom.querySelector<HTMLElement>(`.cm-embedded-block-wrapper[data-embed-from="${link.from}"][data-embed-part="title"] [data-embed-nav-title], .cm-embedded-block-wrapper[data-embed-from="${link.from}"][data-embed-part="full"] [data-embed-nav-title]`));
        if (!title) return false;
        occurrencePath.push(`${target.id}@${link.from}`);
        const key = JSON.stringify(occurrencePath);
        const findHost = () => Array.from(panel.querySelectorAll<HTMLElement>('[data-occurrence-key]'))
            .find(element => element.dataset.occurrenceKey === key);
        let host = findHost();
        if (!host) title.click();
        host = await findUntil(findHost) || undefined;
        if (!host) return false;
        view = await findUntil(() => editorIn(host!));
        if (!view) return false;
    }
    const position = Math.min(node.from, view.state.doc.length);
    view.dispatch({ effects: EditorView.scrollIntoView(position, { y: 'start', yMargin: 80 }) });
    if (node.kind !== 'heading') {
        const title = await findUntil(() => view!.dom.querySelector<HTMLElement>(`.cm-embedded-block-wrapper[data-embed-from="${position}"] [data-embed-nav-title]`));
        title?.scrollIntoView({ block: 'center' });
    }
    return true;
}

export function ContentOutline({ rootId, onClose }: { rootId: string; onClose: () => void }) {
    const blocksById = useStore(state => state.blocksById);
    const idsByLabel = useStore(state => state.blockIdByLabel);
    const nodes = useMemo(() => buildContentOutline(rootId, blocksById, idsByLabel), [rootId, blocksById, idsByLabel]);
    const visibleNodes = () => {
        const visible = new Set<string>();
        const collect = (items: OutlineNode[]) => items.forEach(node => {
            if (node.kind !== 'heading' && parseEmbeddedLinks(blocksById[node.blockId]?.content || '')
                .some(link => link.from === node.from && link.open)) visible.add(node.key);
            collect(node.children);
        });
        collect(nodes);
        return visible;
    };
    const [collapsed, setCollapsed] = useState<Set<string>>(visibleNodes);
    const [filterOpen, setFilterOpen] = useState(false);
    const [filters, setFilters] = useState({ heading: true, standout: true, inlineOpen: false, inlineClosed: false });
    const hiddenFilters = Object.values(filters).filter(enabled => !enabled).length;
    const [selected, setSelected] = useState<string | null>(null);
    const [error, setError] = useState('');
    const [loadingKeys, setLoadingKeys] = useState<Set<string>>(new Set());
    const [failedKeys, setFailedKeys] = useState<Set<string>>(new Set());

    const collapseAll = () => {
        const allCollapsed = new Set<string>();
        const collect = (items: OutlineNode[]) => items.forEach(node => {
            if (node.kind === 'heading') allCollapsed.add(node.key);
            collect(node.children);
        });
        collect(nodes);
        setCollapsed(allCollapsed);
    };

    const restoreView = () => {
        setCollapsed(visibleNodes());
    };

    const loadNode = (node: OutlineNode) => {
        if (loadingKeys.has(node.key)) return;
        const target = parseEmbeddedLinks(blocksById[node.blockId]?.content || '').find(link => link.from === node.from);
        const label = target && (target.relative ? `${blocksById[node.blockId].label}${target.label}` : target.label);
        const id = label && idsByLabel[label];
        if (!id) return;
        setFailedKeys(current => { const next = new Set(current); next.delete(node.key); return next; });
        setLoadingKeys(current => new Set(current).add(node.key));
        void useStore.getState().loadBlockContent(id).then(() => {
            setLoadingKeys(current => { const next = new Set(current); next.delete(node.key); return next; });
        }).catch(() => {
            setLoadingKeys(current => { const next = new Set(current); next.delete(node.key); return next; });
            setFailedKeys(current => new Set(current).add(node.key));
        });
    };
    const toggle = (node: OutlineNode) => {
        const willExpand = node.kind === 'heading' ? collapsed.has(node.key) : !collapsed.has(node.key);
        setCollapsed(current => {
            const next = new Set(current);
            if (next.has(node.key)) next.delete(node.key); else next.add(node.key);
            return next;
        });
        if (willExpand && node.unloaded) loadNode(node);
    };
    const render = (items: OutlineNode[], depth = 0): ReactNode => items.map(node => {
        const hasChildren = !!node.children.length || node.unloaded;
        const isCollapsed = collapsed.has(node.key) !== (node.kind !== 'heading');
        const isOpen = node.kind !== 'heading' && parseEmbeddedLinks(blocksById[node.blockId]?.content || '').some(link => link.from === node.from && link.open);
        const shown = node.kind === 'heading' ? filters.heading : node.kind === 'standout' ? filters.standout : isOpen ? filters.inlineOpen : filters.inlineClosed;
        if (!shown) return node.kind === 'heading' || isOpen ? <div key={node.key}>{render(node.children, depth)}</div> : null;
        return <div key={node.key} role="treeitem" aria-expanded={hasChildren ? !isCollapsed : undefined}>
            <div className={`flex items-center min-w-0 rounded-md text-sm hover:bg-accent/10 ${selected === node.key ? 'bg-accent/15 text-accent' : 'text-primary'}`} style={{ paddingLeft: `${Math.min(depth, 12) * 12 + 6}px` }}>
                {hasChildren ? <button type="button" aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${node.title}`} onClick={() => toggle(node)} className="p-1 rounded hover:bg-accent/20 shrink-0">{isCollapsed ? <ChevronRight size={14}/> : <ChevronDown size={14}/>}</button>
                    : <span className="w-[22px] shrink-0"/>}
                <button type="button" className={`min-w-0 flex-1 py-1.5 pr-2 text-left truncate ${node.kind === 'heading' ? 'font-medium' : 'text-secondary'}`}
                    title={node.title} onClick={() => { setSelected(node.key); setError(''); void navigate(rootId, node).then(ok => { if (!ok) setError('Could not reveal this section.'); }).catch(() => setError('Could not reveal this section.')); }}>
                    <MathTitle text={node.title}/>
                </button>
                {loadingKeys.has(node.key) && <Loader2 size={14} className="mr-2 shrink-0 animate-spin text-secondary" aria-label={`Loading ${node.title}`}/>}
                {failedKeys.has(node.key) && <button type="button" onClick={() => loadNode(node)} aria-label={`Retry loading ${node.title}`} title="Could not load sections. Retry" className="mr-1 rounded p-1 text-red-400 hover:bg-surface"><RotateCcw size={14}/></button>}
            </div>
            {hasChildren && !isCollapsed && <div role="group">{node.unloaded && <span className="block min-h-6 pl-9 text-xs text-secondary">{loadingKeys.has(node.key) ? '' : failedKeys.has(node.key) ? 'Could not load sections' : 'Expand to load sections'}</span>}{render(node.children, depth + 1)}</div>}
        </div>;
    });

    return <aside className="w-64 shrink-0 h-full border-r border-outline bg-sidebar flex flex-col" aria-label="Content outline" data-testid="content-outline">
        <div className="relative mx-2 mt-2 flex items-center justify-end gap-1 border-b border-outline pb-2">
            <button type="button" onClick={collapseAll} title="Collapse all sections" className="rounded-md px-2 py-2 text-xs text-secondary hover:bg-surface hover:text-accent">Collapse all</button>
            <button type="button" onClick={restoreView} title="Show the sections open in the note" className="rounded-md px-2 py-2 text-xs text-secondary hover:bg-surface hover:text-accent">Match note</button>
            <button type="button" aria-label="Filter outline" title={`${hiddenFilters} title types hidden`} aria-expanded={filterOpen} onClick={() => setFilterOpen(open => !open)} className="flex items-center rounded-md px-2 py-2 text-secondary hover:bg-surface hover:text-accent"><SlidersHorizontal size={16}/></button>
            <button type="button" onClick={onClose} aria-label="Close content outline" title="Close content outline" className="absolute -right-12 top-0 z-10 rounded-md border border-outline bg-surface p-2 text-secondary shadow-md hover:bg-[#263247] hover:text-accent"><X size={16}/></button>
        {filterOpen && <div className="absolute right-0 top-full z-50 mt-1 w-52 rounded-md border border-outline bg-surface p-2 text-xs text-primary shadow-xl" aria-label="Outline filters">
            <div className="mb-1 border-b border-outline px-1 pb-2 font-semibold">Filter</div>
            <label className="flex items-center gap-2 rounded px-1 py-1 hover:bg-accent/10"><input type="checkbox" checked={filters.heading} onChange={event => setFilters(current => ({ ...current, heading: event.target.checked }))}/>Headings</label>
            <label className="flex items-center gap-2 rounded px-1 py-1 hover:bg-accent/10"><input type="checkbox" checked={filters.standout} onChange={event => setFilters(current => ({ ...current, standout: event.target.checked }))}/>Standout titles</label>
            <div className="mt-1 border-t border-outline px-1 pt-2 font-medium text-secondary">Inline titles</div>
            <label className="flex items-center gap-2 rounded px-1 py-1 pl-4 hover:bg-accent/10"><input type="checkbox" checked={filters.inlineOpen} onChange={event => setFilters(current => ({ ...current, inlineOpen: event.target.checked }))}/>Open</label>
            <label className="flex items-center gap-2 rounded px-1 py-1 pl-4 hover:bg-accent/10"><input type="checkbox" checked={filters.inlineClosed} onChange={event => setFilters(current => ({ ...current, inlineClosed: event.target.checked }))}/>Closed</label>
        </div>}
        </div>
        <nav className="overflow-y-auto flex-1 px-2 py-2" role="tree" aria-label="Sections in reading order">
            {nodes.length ? render(nodes) : <p className="px-2 py-3 text-xs text-secondary">No headings or standout titles yet.</p>}
            {error && <p role="alert" className="px-2 py-2 text-xs text-red-400">{error}</p>}
        </nav>
    </aside>;
}
