import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Boxes, ChevronDown, ChevronRight, FileText, Folder, Minus, Plus, RotateCcw, Search, SlidersHorizontal, X } from 'lucide-react';
import { getOrderedBlocks, useStore } from '../store';
import { BlockMapNode, buildBlockMapModel } from '../lib/block-map';
import { parseEmbeddedLinks, resolveEmbeddedLabel } from '../lib/embedded-link-syntax';
import { MathTitle } from './MathTitle';
import './blocks-view.css';

type Row = { key: string; path: string; depth: number; node?: BlockMapNode; children: boolean; count: number };
const states: Record<string, string> = { all: 'All states', empty: 'Empty', broken: 'Unresolved references', duplicate: 'Duplicate labels', 'reference-isolated': 'No reference connections', 'fully-isolated': 'Fully isolated' };

export function BlockMapModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
    const revision = useStore(s => s.blocksRevision);
    const blocks = useMemo(() => getOrderedBlocks(useStore.getState()), [revision]);
    const model = useMemo(() => buildBlockMapModel(blocks), [blocks]);
    const [query, setQuery] = useState('');
    const [health, setHealth] = useState('all');
    const [namespace, setNamespace] = useState('');
    const [degree, setDegree] = useState('all');
    const [matchesOnly, setMatchesOnly] = useState(false);
    const [density, setDensity] = useState('Blocks');
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [preview, setPreview] = useState('');
    const [viewingPath, setViewingPath] = useState('');
    const [inspectorWidth, setInspectorWidth] = useState(420);
    const search = useRef<HTMLInputElement>(null);
    const scroll = useRef<HTMLDivElement>(null);
    const dialog = useRef<HTMLDivElement>(null);
    const pendingReveal = useRef<string | null>(null);
    const selected = selectedId ? model.nodeById[selectedId] : undefined;
    const filtered = !!query.trim() || health !== 'all' || !!namespace || degree !== 'all';
    const tree = useMemo(() => {
        const entries = new Map<string, { nodes: BlockMapNode[]; children: Set<string>; count: number }>();
        entries.set('', { nodes: [], children: new Set(), count: 0 });
        for (const node of model.nodes) {
            const parts = node.label.split('/'); let parent = '';
            parts.forEach((_, i) => {
                const path = parts.slice(0, i + 1).join('/');
                if (!entries.has(path)) entries.set(path, { nodes: [], children: new Set(), count: 0 });
                entries.get(parent)!.children.add(path); entries.get(path)!.count++; parent = path;
            });
            entries.get(parent)!.nodes.push(node);
        }
        return entries;
    }, [model]);
    const matches = useMemo(() => model.nodes.filter(n => {
        const text = `${n.title} ${n.label}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
        const status = health === 'all' || (health === 'fully-isolated' ? n.health.includes('orphan') : health === 'reference-isolated' ? !n.incomingIds.length && !n.outgoingIds.length && !n.brokenTargets.length && !n.ambiguousTargets.length : n.health.includes(health as any));
        return text && status && (!namespace || n.label === namespace || n.label.startsWith(namespace + '/')) && (degree === 'all' || (degree === 'incoming' ? n.incomingIds.length > 0 : n.outgoingIds.length > 0));
    }), [model, query, health, namespace, degree]);
    const matchIds = useMemo(() => new Set(matches.map(n => n.id)), [matches]);
    const contextPaths = useMemo(() => {
        const result = new Set<string>();
        for (const n of matches) { const parts = n.label.split('/'); parts.forEach((_, i) => result.add(parts.slice(0, i + 1).join('/'))); }
        return result;
    }, [matches]);
    const rows = useMemo(() => {
        if (matchesOnly) return [...matches].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })).map(node => ({ key: node.id, path: node.label, depth: 0, node, children: false, count: 1 }));
        const result: Row[] = [];
        const visit = (parent: string, depth: number) => {
            const children = [...(tree.get(parent)?.children || [])].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
            for (const path of children) {
                if (filtered && !contextPaths.has(path)) continue;
                const entry = tree.get(path)!;
                if (entry.nodes.length) entry.nodes.forEach(node => result.push({ key: node.id, node, path, depth, children: !!entry.children.size, count: entry.count }));
                else result.push({ key: `namespace:${path}`, path, depth, children: !!entry.children.size, count: entry.count });
                if (density !== 'Workspace' && (filtered || expanded.has(path) || (density === 'Branches' && depth < 1))) visit(path, depth + 1);
            }
        }; visit('', 0); return result;
    }, [tree, matchesOnly, matches, filtered, contextPaths, density, expanded]);
    const virtual = useVirtualizer({ count: rows.length, getScrollElement: () => scroll.current, estimateSize: () => density === 'Detail' ? 96 : 68, overscan: 8, getItemKey: i => rows[i].key });
    useEffect(() => { virtual.measure(); }, [density]);
    useEffect(() => {
        // Expanding or collapsing a node rebuilds `rows`. Keep the current
        // scroll context when that branch is still represented; resetting to
        // rows[0] makes the breadcrumb jump until the next scroll event.
        if (viewingPath && rows.some(row => row.path === viewingPath || row.path.startsWith(`${viewingPath}/`))) return;
        const first = rows[0];
        if (!first) return setViewingPath('');
        const parts = first.path.split('/');
        setViewingPath(first.depth === 0 ? first.path : parts.slice(0, -1).join('/'));
    }, [rows, viewingPath]);
    useEffect(() => { const before = document.activeElement as HTMLElement | null; search.current?.focus(); return () => before?.focus(); }, []);
    useEffect(() => {
        let current = true; setPreview('');
        if (selectedId) useStore.getState().loadBlockContent(selectedId).then(() => {
            if (current) setPreview(useStore.getState().blocksById[selectedId]?.content || '');
        }).catch(() => { if (current) setPreview('Preview could not be loaded. Open the note to retry.'); });
        return () => { current = false; };
    }, [selectedId, revision]);
    const mentionCounts = useMemo(() => {
        const counts = new Map<string, number>();
        if (selected) for (const link of parseEmbeddedLinks(preview)) { const label = resolveEmbeddedLabel(link, selected.label); counts.set(label, (counts.get(label) || 0) + 1); }
        return counts;
    }, [preview, selected?.label]);
    const select = (id: string) => setSelectedId(id);
    const inspectRelated = (id: string) => {
        select(id);
        if (filtered) return;
        const node = model.nodeById[id];
        if (!node) return;
        setExpanded(current => {
            const next = new Set(current); const parts = node.label.split('/');
            parts.forEach((_, i) => next.add(parts.slice(0, i + 1).join('/')));
            return next;
        });
        pendingReveal.current = id;
    };
    const clear = () => { setQuery(''); setHealth('all'); setNamespace(''); setDegree('all'); setMatchesOnly(false); };
    const reveal = (id: string) => {
        const node = model.nodeById[id]; if (!node) return;
        clear(); setDensity('Blocks');
        setExpanded(current => { const next = new Set(current); const parts = node.label.split('/'); parts.forEach((_, i) => next.add(parts.slice(0, i + 1).join('/'))); return next; });
        select(id); pendingReveal.current = id;
    };
    useEffect(() => {
        if (!pendingReveal.current) return;
        const index = rows.findIndex(r => r.node?.id === pendingReveal.current);
        if (index >= 0) { virtual.scrollToIndex(index, { align: 'center' }); pendingReveal.current = null; }
    }, [rows, virtual]);
    const open = (id: string) => { useStore.getState().openBlockInTab(id, true); onClose(); };
    const toggle = (path: string) => setExpanded(current => { const next = new Set(current); next.has(path) ? next.delete(path) : next.add(path); return next; });
    const updateViewingPath = (scrollTop: number) => {
        // Change branches at the visual midpoint of a row. This holds the
        // current branch while most of its row remains visible, then updates
        // as it moves halfway above the top edge instead of waiting until it
        // has almost disappeared.
        const item = virtual.getVirtualItems().find(candidate => candidate.end > scrollTop + candidate.size / 2);
        const row = item ? rows[item.index] : rows[0];
        if (!row) return;
        const parts = row.path.split('/');
        const branch = row.depth === 0 ? row.path : parts.slice(0, -1).join('/');
        setViewingPath(current => current === branch ? current : branch);
    };
    const scrollToPath = (path: string) => {
        const index = rows.findIndex(row => row.path === path);
        if (index >= 0) virtual.scrollToIndex(index, { align: 'start' });
    };
    if (!isOpen) return null;
    return <div className="bv-overlay" role="dialog" aria-modal="true" aria-labelledby="blocks-view-title" ref={dialog} onKeyDown={e => {
        if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
        if (e.key === 'Tab') {
            const controls = (Array.from(dialog.current?.querySelectorAll('button:not(:disabled), input, select, [tabindex="0"]') || []) as HTMLElement[]).filter(el => el.getClientRects().length);
            const first = controls[0], last = controls[controls.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
            if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
        }
    }}><div className="bv-shell">
        <header className="bv-header"><Boxes size={22}/><div><h2 id="blocks-view-title">Blocks View</h2><p>{model.nodes.length.toLocaleString()} notes · a place for every idea</p></div><button className="bv-icon" aria-label="Close blocks view" onClick={onClose}><X size={20}/></button></header>
        <div className="bv-tools"><div className="bv-search"><Search size={16}/><input ref={search} value={query} onChange={e => setQuery(e.target.value)} placeholder="Find a title or label…" aria-label="Search blocks view"/></div>{filtered && <div className="bv-filter-result" role="status"><strong>{matches.length}</strong> of {model.nodes.length}<button onClick={clear}>Clear</button></div>}<details className="bv-filter-menu"><summary><SlidersHorizontal size={14}/> Filters{filtered && <strong>{[health !== 'all', !!namespace, degree !== 'all'].filter(Boolean).length}</strong>}</summary><div className="bv-filter-panel"><div className="bv-filter-heading"><span>Filter blocks</span>{filtered && <button onClick={clear}>Clear all</button>}</div><label>State<select aria-label="Filter by state" value={health} onChange={e => setHealth(e.target.value)}>{Object.entries(states).map(([s, label]) => <option key={s} value={s}>{label}</option>)}</select></label><label>Namespace<select aria-label="Filter by namespace" value={namespace} onChange={e => setNamespace(e.target.value)}><option value="">Every namespace</option>{[...new Set([...(tree.get('')?.children || []), ...(namespace ? [namespace] : [])])].sort().map(p => <option key={p}>{p}</option>)}</select></label><p>A namespace is a label-path prefix that groups related notes, such as <code>analysis/sequences</code>. It can exist visually without being a note.</p><label>References<select aria-label="Filter by references" value={degree} onChange={e => setDegree(e.target.value)}><option value="all">Any connections</option><option value="incoming">Has backlinks</option><option value="outgoing">Has references</option></select></label><label className="bv-filter-check"><input type="checkbox" checked={matchesOnly} onChange={e => setMatchesOnly(e.target.checked)}/> Show matches only</label></div></details></div>
        <div className="bv-body"><main className="bv-main">
            <>
                <div className="bv-list-tools"><strong>Label hierarchy</strong><select aria-label="Information density" value={density} onChange={e => setDensity(e.target.value)}>{['Workspace', 'Branches', 'Blocks', 'Detail'].map(d => <option key={d}>{d}</option>)}</select><button onClick={() => setExpanded(new Set())}>Collapse all</button></div>
                <div className="bv-viewing-bar" aria-live="polite">
                    <div><span className="bv-viewing-label">Viewing</span><PathBreadcrumb path={viewingPath} onJump={scrollToPath}/></div>
                    {selected && <button className="bv-viewing-selection" onClick={() => reveal(selected.id)} title={selected.label}><span>Selected</span>{selected.label}</button>}
                </div>
                <div ref={scroll} onScroll={event => { const scrollTop = event.currentTarget.scrollTop; requestAnimationFrame(() => updateViewingPath(scrollTop)); }} className="bv-scroll" aria-label="Blocks hierarchy" data-testid="blocks-list">{!rows.length && <div className="bv-empty">No matching notes. <button onClick={clear}>Clear filters</button></div>}<div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
                    {virtual.getVirtualItems().map(item => { const row = rows[item.index]; const node = row.node; const context = filtered && (!node || !matchIds.has(node.id)); return <div key={row.key} className={`bv-row ${node?.id === selectedId ? 'bv-selected' : ''} ${context ? 'bv-context' : ''}`} style={{ position: 'absolute', top: item.start, height: item.size, width: '100%', paddingLeft: 12 + Math.min(row.depth, 10) * 16, '--bv-depth': Math.min(row.depth, 10) } as React.CSSProperties}>
                        {row.children ? <button className="bv-expander" aria-expanded={expanded.has(row.path) || filtered || (density === 'Branches' && row.depth < 1)} aria-label={`${expanded.has(row.path) || filtered ? 'Collapse' : 'Expand'} ${row.path}`} disabled={filtered || density === 'Workspace'} onClick={() => toggle(row.path)}>{expanded.has(row.path) || filtered || (density === 'Branches' && row.depth < 1) ? <ChevronDown size={15}/> : <ChevronRight size={15}/>}</button> : <span className="bv-expander"/>}
                        <button className="bv-row-content" data-testid={node ? `block-map-node-${node.id}` : 'namespace-row'} aria-label={node ? `${node.title || 'Untitled'} — ${node.label}` : `Namespace ${row.path}`} aria-current={node?.id === selectedId ? 'true' : undefined} onClick={() => node ? select(node.id) : toggle(row.path)} onDoubleClick={() => node && open(node.id)} onKeyDown={e => {
                            if (e.key === 'Enter' && node) { e.preventDefault(); open(node.id); }
                            if (e.key === 'ArrowRight' && row.children) { e.preventDefault(); setExpanded(s => new Set([...s, row.path])); }
                            if (e.key === 'ArrowLeft') { e.preventDefault(); setExpanded(s => { const next = new Set(s); next.delete(row.path); return next; }); }
                            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const index = Math.max(0, Math.min(rows.length - 1, item.index + (e.key === 'ArrowDown' ? 1 : -1))); virtual.scrollToIndex(index); requestAnimationFrame(() => scroll.current?.querySelector<HTMLButtonElement>(`[data-row-index="${index}"]`)?.focus()); }
                        }} data-row-index={item.index} title={`${node?.title || 'Namespace'}\n${row.path}`}>
                            {node ? <FileText size={16}/> : <Folder size={16} strokeDasharray="3 2"/>}<span className="bv-row-text"><span className="bv-title">{node ? <MathTitle text={node.title || node.label}/> : row.path.split('/').pop()}</span><span className={`bv-path ${density === 'Detail' ? 'bv-wrap' : ''}`}>{row.depth > 10 ? `Depth ${row.depth + 1} · ` : ''}{row.path}</span></span>
                            <span className="bv-row-meta">{context && <small>context</small>}{!node && <small>namespace · {row.count}</small>}{node && <><span title="Distinct backlinks / outgoing targets">← {node.incomingIds.length} · → {node.outgoingIds.length}</span><span>{node.health.map(h => <small key={h} className={`bv-badge bv-state-${h}`}>{h === 'orphan' ? 'isolated' : h}</small>)}</span></>}</span>
                        </button>
                    </div>; })}
                </div></div>
            </>
        </main><div className="bv-divider" role="separator" aria-label="Resize hierarchy and relationships panes" aria-orientation="vertical" aria-valuemin={300} aria-valuemax={650} aria-valuenow={inspectorWidth} tabIndex={0} onKeyDown={event => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault(); setInspectorWidth(width => Math.max(300, Math.min(650, width + (event.key === 'ArrowLeft' ? 24 : -24))));
        }} onPointerDown={event => {
            event.currentTarget.setPointerCapture(event.pointerId);
            const startX = event.clientX, startWidth = inspectorWidth;
            const move = (moveEvent: PointerEvent) => setInspectorWidth(Math.max(300, Math.min(650, startWidth + startX - moveEvent.clientX)));
            const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
            window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
        }}/><aside className="bv-inspector bv-map-only" aria-label="Block inspector" style={{ width: inspectorWidth }}>{selected ? <>{filtered && !matchIds.has(selected.id) && <p className="bv-notice">Selected note is outside the current filters.</p>}<RelationshipMap node={selected} model={model.nodeById} onSelect={inspectRelated} mentions={mentionCounts} onOpen={() => open(selected.id)} onReveal={() => reveal(selected.id)}/></> : <div className="bv-empty"><FileText size={30}/><h3>Select a note</h3><p>Its parent, children, incoming references, and outgoing references will appear here.</p></div>}</aside></div>
        <footer className="bv-footer"><span>▱ Namespace &nbsp; ▤ Note &nbsp; ← Backlinks &nbsp; → References</span><span>Single click: inspect · Double click / Enter: open</span></footer>
    </div></div>;
}
function PathBreadcrumb({ path, onJump }: { path: string; onJump: (path: string) => void }) {
    if (!path) return <span className="bv-viewing-empty">No visible branch</span>;
    const parts = path.split('/');
    const shown = parts.length > 4 ? [parts[0], '…', ...parts.slice(-2)] : parts;
    return <div className="bv-viewing-path" title={path}>{shown.map((part, index) => {
        const originalIndex = part === '…' ? -1 : parts.length > 4 && index > 1 ? parts.length - (shown.length - index) : index;
        const target = originalIndex >= 0 ? parts.slice(0, originalIndex + 1).join('/') : '';
        return <React.Fragment key={`${part}-${index}`}>{index > 0 && <span aria-hidden="true">/</span>}{part === '…' ? <span className="bv-viewing-ellipsis" aria-label={`${parts.length - 3} hidden levels`}>…</span> : <button onClick={() => onJump(target)}>{part}</button>}</React.Fragment>;
    })}</div>;
}
function Problems({ node }: { node: BlockMapNode }) {
    return <section className="bv-problems">{node.brokenTargets.map(label => <div key={label} data-testid="block-map-missing-target"><strong>⚠ Missing target</strong><code>{label}</code></div>)}{node.ambiguousTargets.map(label => <div key={label}><strong>⚠ Ambiguous target · multiple notes use this label</strong><code>{label}</code></div>)}{node.health.includes('duplicate') && <p>⚠ Duplicate label. Resolve the conflict before relying on label-based references. Matching titles alone are not duplicates.</p>}</section>;
}
function RelationshipMap({ node, model, onSelect, mentions, onOpen, onReveal }: { node: BlockMapNode; model: Record<string, BlockMapNode>; onSelect: (id: string) => void; mentions: Map<string, number>; onOpen: () => void; onReveal: () => void }) {
    type MapKind = 'parent' | 'incoming' | 'selected' | 'outgoing' | 'children';
    type MapNode = { key: string; id: string; kind: MapKind; title: string; label: string; x: number; y: number; width: number; height: number };
    const viewport = useRef<HTMLDivElement>(null);
    const [size, setSize] = useState({ width: 560, height: 640 });
    const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
    const [moved, setMoved] = useState<Record<string, { x: number; y: number }>>({});
    const dragged = useRef(false);
    const selectedClick = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => { if (selectedClick.current) clearTimeout(selectedClick.current); }, []);
    useEffect(() => {
        const element = viewport.current; if (!element) return;
        const resize = () => setSize({ width: element.clientWidth, height: element.clientHeight });
        resize(); const observer = new ResizeObserver(resize); observer.observe(element); return () => observer.disconnect();
    }, []);
    const initialView = () => { const scale = .82; return { x: size.width * (1 - scale) / 2, y: size.height * (1 - scale) / 2, scale }; };
    useEffect(() => { setView(initialView()); setMoved({}); }, [node.id]);
    const graph = useMemo(() => {
        const width = Math.max(360, size.width), height = Math.max(440, size.height), cx = width / 2, cy = height / 2;
        const dimensions = (kind: MapKind, title: string) => {
            const selected = kind === 'selected';
            const nodeWidth = Math.round(Math.min(selected ? 320 : 220, Math.max(selected ? 156 : 112, (selected ? 126 : 94) + Math.sqrt(title.length) * (selected ? 11 : 8))));
            const charactersPerLine = Math.max(10, Math.floor((nodeWidth - 22) / (selected ? 7 : 6.2)));
            const lines = Math.max(1, Math.ceil(title.length / charactersPerLine));
            return { width: nodeWidth, height: (selected ? 50 : 43) + lines * (selected ? 17 : 14) };
        };
        const selectedTitle = node.title || node.label;
        const selectedSize = dimensions('selected', selectedTitle);
        const result: MapNode[] = [{ key: `selected:${node.id}`, id: node.id, kind: 'selected', title: selectedTitle, label: node.label, x: cx, y: cy, ...selectedSize }];
        const relations = new Map<string, Set<'parent' | 'children' | 'outgoing' | 'incoming'>>();
        const addRelation = (kind: 'parent' | 'children' | 'outgoing' | 'incoming', ids: string[]) => ids.filter(id => id !== node.id).forEach(id => { const kinds = relations.get(id) || new Set(); kinds.add(kind); relations.set(id, kinds); });
        addRelation('parent', node.parentId ? [node.parentId] : []); addRelation('children', node.childIds); addRelation('outgoing', node.outgoingIds); addRelation('incoming', node.incomingIds);
        const priority: Array<'parent' | 'children' | 'outgoing' | 'incoming'> = ['parent', 'children', 'outgoing', 'incoming'];
        const placed = new Map<MapKind, string[]>();
        for (const [id, kinds] of relations) { const kind = priority.find(candidate => kinds.has(candidate))!; placed.set(kind, [...(placed.get(kind) || []), id]); }
        const position = (kind: MapKind, index: number, total: number, nodeSize: { width: number; height: number }, groupSize: { width: number; height: number }) => {
            if (kind === 'parent') return { x: cx, y: cy - selectedSize.height / 2 - nodeSize.height / 2 - 64 };
            if (kind === 'children') { const row = Math.floor(index / 5), inRow = Math.min(5, total - row * 5), column = index % 5; return { x: cx + (column - (inRow - 1) / 2) * (groupSize.width + 26), y: cy + selectedSize.height / 2 + nodeSize.height / 2 + 68 + row * (groupSize.height + 30) }; }
            const column = Math.floor(index / 5), inColumn = Math.min(5, total - column * 5), row = index % 5;
            const horizontal = selectedSize.width / 2 + nodeSize.width / 2 + 70 + column * (groupSize.width + 34);
            return { x: kind === 'incoming' ? cx - horizontal : cx + horizontal, y: cy + (row - (inColumn - 1) / 2) * (groupSize.height + 28) };
        };
        for (const kind of priority) {
            const ids = placed.get(kind) || [];
            const items = ids.map(id => { const related = model[id]; const title = related.title || related.label; return { id, related, title, size: dimensions(kind, title) }; });
            const groupSize = items.reduce((largest, item) => ({ width: Math.max(largest.width, item.size.width), height: Math.max(largest.height, item.size.height) }), { width: 112, height: 58 });
            items.forEach((item, index) => result.push({ key: `related:${item.id}`, id: item.id, kind, title: item.title, label: item.related.label, ...item.size, ...position(kind, index, items.length, item.size, groupSize) }));
        }
        return result.map(item => ({ ...item, ...(moved[item.key] || {}) }));
    }, [node, model, size, moved]);
    const selectedKey = `selected:${node.id}`;
    const selectedNode = graph.find(item => item.key === selectedKey)!;
    const relatedById = new Map<string, MapNode>(graph.filter(item => item.kind !== 'selected').map(item => [item.id, item] as [string, MapNode]));
    const links: Array<{ source: MapNode; target: MapNode; kind: 'hierarchy' | 'reference'; relation: 'parent' | 'child' | 'reference' | 'backlink'; offset?: number }> = [];
    if (node.parentId && relatedById.has(node.parentId)) links.push({ source: relatedById.get(node.parentId)!, target: selectedNode, kind: 'hierarchy', relation: 'parent' });
    node.childIds.forEach(id => relatedById.has(id) && links.push({ source: selectedNode, target: relatedById.get(id)!, kind: 'hierarchy', relation: 'child' }));
    node.outgoingIds.filter(id => id !== node.id).forEach(id => relatedById.has(id) && links.push({ source: selectedNode, target: relatedById.get(id)!, kind: 'reference', relation: 'reference' }));
    node.incomingIds.filter(id => id !== node.id).forEach(id => relatedById.has(id) && links.push({ source: relatedById.get(id)!, target: selectedNode, kind: 'reference', relation: 'backlink' }));
    if (node.incomingIds.includes(node.id)) links.push({ source: selectedNode, target: selectedNode, kind: 'reference', relation: 'reference' });
    const linksByNeighbor = new Map<string, typeof links>();
    links.forEach(link => { const neighbor = link.source.id === node.id ? link.target.id : link.source.id; linksByNeighbor.set(neighbor, [...(linksByNeighbor.get(neighbor) || []), link]); });
    for (const group of linksByNeighbor.values()) group.forEach((link, index) => { link.offset = (index - (group.length - 1) / 2) * 18; });
    const edgePoints = (source: MapNode, target: MapNode) => {
        const dx = target.x - source.x, dy = target.y - source.y, length = Math.max(1, Math.hypot(dx, dy));
        const boundaryDistance = (item: MapNode) => {
            const scale = 1 / Math.max(Math.abs(dx) / Math.max(1, item.width / 2), Math.abs(dy) / Math.max(1, item.height / 2));
            return Math.min(length / 2, length * scale + 3);
        };
        const sourceInset = boundaryDistance(source), targetInset = boundaryDistance(target);
        return { x1: source.x + dx / length * sourceInset, y1: source.y + dy / length * sourceInset, x2: target.x - dx / length * targetInset, y2: target.y - dy / length * targetInset };
    };
    const resetView = () => setView(initialView());
    const startPan = (event: React.PointerEvent<HTMLDivElement>) => {
        if (event.target !== event.currentTarget && (event.target as HTMLElement).closest('.bv-graph-node,.bv-graph-controls')) return;
        event.currentTarget.setPointerCapture(event.pointerId); const origin = { x: event.clientX, y: event.clientY, view };
        const move = (moveEvent: React.PointerEvent<HTMLDivElement>) => setView({ ...origin.view, x: origin.view.x + moveEvent.clientX - origin.x, y: origin.view.y + moveEvent.clientY - origin.y });
        const current = event.currentTarget; current.onpointermove = move as any; current.onpointerup = () => { current.onpointermove = null; current.onpointerup = null; };
    };
    const startDrag = (event: React.PointerEvent<HTMLElement>, item: MapNode) => {
        event.stopPropagation(); dragged.current = false; event.currentTarget.setPointerCapture(event.pointerId); const origin = { x: event.clientX, y: event.clientY, node: { x: item.x, y: item.y } };
        const current = event.currentTarget; current.onpointermove = ((moveEvent: PointerEvent) => { const dx = moveEvent.clientX - origin.x, dy = moveEvent.clientY - origin.y; if (Math.hypot(dx, dy) < 4) return; dragged.current = true; setMoved(values => ({ ...values, [item.key]: { x: origin.node.x + dx / view.scale, y: origin.node.y + dy / view.scale } })); }) as any; current.onpointerup = () => { current.onpointermove = null; current.onpointerup = null; };
    };
    const clickNode = (item: MapNode) => {
        if (dragged.current || item.kind !== 'selected') return;
        selectedClick.current = setTimeout(() => { onReveal(); selectedClick.current = null; }, 220);
    };
    const doubleClickNode = (item: MapNode) => {
        if (dragged.current) return;
        if (selectedClick.current) { clearTimeout(selectedClick.current); selectedClick.current = null; }
        if (item.kind === 'selected') onOpen(); else if (item.id) onSelect(item.id);
    };
    return <section className="bv-relationship-primary" aria-label="Relationship map">
            <div className="bv-relationship-map" ref={viewport} onPointerDown={startPan} onWheel={event => { event.preventDefault(); const delta = Math.max(-80, Math.min(80, event.deltaY)); const factor = Math.exp(-delta * .0015); setView(current => ({ ...current, scale: Math.max(.45, Math.min(2.5, current.scale * factor)) })); }}>
            <div className="bv-graph-label">Relationship map <span>Drag nodes · pan · scroll to zoom</span></div>
            <div className="bv-graph-controls"><button aria-label="Zoom out" title="Zoom out" onClick={() => setView(current => ({ ...current, scale: Math.max(.45, current.scale - .15) }))}><Minus size={14}/></button><button aria-label="Reset graph view" title="Return to the default graph view" onClick={resetView}><RotateCcw size={14}/></button><button aria-label="Zoom in" title="Zoom in" onClick={() => setView(current => ({ ...current, scale: Math.min(2.5, current.scale + .15) }))}><Plus size={14}/></button></div>
            <div className="bv-graph-scene" style={{ width: Math.max(360, size.width), height: Math.max(440, size.height), transform: `translate(${view.x}px,${view.y}px) scale(${view.scale})` }}>
                <svg className="bv-graph-edges" width={Math.max(360, size.width)} height={Math.max(440, size.height)} aria-hidden="true"><defs><marker id="bv-arrow-hierarchy" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="10" markerHeight="10" orient="auto-start-reverse"><path d="M 1 1 L 11 6 L 1 11 z"/></marker><marker id="bv-arrow-reference" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="10" markerHeight="10" orient="auto-start-reverse"><path d="M 1 1 L 11 6 L 1 11 z"/></marker></defs>{links.map((link, index) => { const points = edgePoints(link.source, link.target); const dx = points.x2 - points.x1, dy = points.y2 - points.y1, length = Math.max(1, Math.hypot(dx, dy)), offset = link.offset || 0, mx = (points.x1 + points.x2) / 2 - dy / length * offset, my = (points.y1 + points.y2) / 2 + dx / length * offset; return link.source === link.target ? <path key={`loop-${index}`} className="bv-graph-edge bv-reference-edge" d={`M ${link.source.x + link.source.width / 2} ${link.source.y - link.source.height / 4} C ${link.source.x + link.source.width} ${link.source.y - link.source.height}, ${link.source.x + link.source.width} ${link.source.y + link.source.height}, ${link.source.x + link.source.width / 2} ${link.source.y + link.source.height / 4}`} markerEnd="url(#bv-arrow-reference)"/> : <path key={`${link.source.key}-${link.target.key}-${link.relation}`} className={`bv-graph-edge bv-${link.kind}-edge`} d={`M ${points.x1} ${points.y1} Q ${mx} ${my} ${points.x2} ${points.y2}`} markerEnd={`url(#bv-arrow-${link.kind})`}/>; })}</svg>
                {graph.map(item => <button type="button" key={item.key} className={`bv-graph-node bv-graph-${item.kind}`} style={{ left: item.x, top: item.y, width: item.width, minHeight: item.height }} onPointerDown={event => startDrag(event, item)} onClick={() => clickNode(item)} onDoubleClick={() => doubleClickNode(item)} onKeyDown={event => { if (event.key !== 'Enter' && event.key !== ' ') return; event.preventDefault(); if (item.kind === 'selected') event.key === 'Enter' ? onOpen() : onReveal(); else onSelect(item.id); }} aria-label={item.kind === 'selected' ? `${item.title}. Selected block. Press Space to reveal in structure or Enter to open.` : `${item.title}. Related block. Press Enter to select.`} title={item.kind === 'selected' ? `${item.title}\n${item.label}\nClick to reveal in structure; double-click to open; drag to reposition` : `${item.title}\n${item.label}\nDouble-click to select; drag to reposition`}>
                    {item.kind === 'selected' && <span className="bv-graph-kind">Selected</span>}<strong><MathTitle text={item.title}/></strong><code>{item.label}</code>{node.outgoingIds.includes(item.id) && (mentions.get(item.label) || 0) > 1 && <small>×{mentions.get(item.label)} mentions</small>}{item.kind === 'selected' && node.incomingIds.includes(node.id) && <small>↻ Self-reference</small>}
                </button>)}
            </div>
            <div className="bv-map-summary"><span>References <strong>{node.outgoingIds.length}</strong></span><span>Backlinks <strong>{node.incomingIds.length}</strong></span><span className="bv-map-legend"><i/> Hierarchy <b/> References · arrows show direction</span></div>
            <Problems node={node}/>
        </div>
    </section>;
}
function RelationList({ title, ids, model, onSelect, mentions }: { title: string; ids: string[]; model: Record<string, BlockMapNode>; onSelect: (id: string) => void; mentions?: Map<string, number> }) {
    const [limit, setLimit] = useState(12); const [group, setGroup] = useState(''); const signature = ids.join('|');
    useEffect(() => { setLimit(12); setGroup(''); }, [signature]);
    const groups = new Map<string, number>();
    for (const id of ids) { const p = model[id].label.split('/').slice(0, 2).join('/'); groups.set(p, (groups.get(p) || 0) + 1); }
    const visible = group ? ids.filter(id => model[id].label === group || model[id].label.startsWith(group + '/')) : ids;
    return <section className="bv-relations"><h4>{title} <span>{ids.length}</span></h4>{ids.length > 20 && <select aria-label={`Group ${title}`} value={group} onChange={e => { setGroup(e.target.value); setLimit(12); }}><option value="">All namespaces</option>{[...groups].sort().map(([p, count]) => <option key={p} value={p}>{p} · {count}</option>)}</select>}{!ids.length && <p className="bv-muted">None</p>}{visible.slice(0, limit).map(id => { const node = model[id]; const count = mentions?.get(node.label); return <button key={id} className="bv-relation" onClick={() => onSelect(id)} title={`${node.title}\n${node.label}`}><MathTitle text={node.title || node.label}/><code>{node.label}</code>{count && count > 1 ? <small>×{count} mentions</small> : null}</button>; })}{visible.length > limit && <button className="bv-more" onClick={() => setLimit(n => n + 24)}>Show next {Math.min(24, visible.length - limit)} · {visible.length - limit} remaining</button>}</section>;
}
