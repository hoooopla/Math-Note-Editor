import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorView } from '@codemirror/view';
import { useVirtualizer } from '@tanstack/react-virtual';
import { setFindHighlight } from '../lib/editor/find-highlight';
import { SearchQuery, setSearchQuery } from '@codemirror/search';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import katex from 'katex';
import { cachedBody, findTextMatches, matchExcerpt, readIndexedBody, resetContentFindCache, type TextMatch } from '../lib/content-find';
import { parseMathExplanations } from '../lib/editor/math-tooltip-syntax';
import { parseRanges, parsedRangesField } from '../lib/editor/katex-plugin';
import { parsedLinksField } from '../lib/editor/embedded-block-plugin';
import { parseEmbeddedLinks, resolveEmbeddedLabel } from '../lib/embedded-link-syntax';
import { useStore } from '../store';

type Scope = 'visible' | 'tabs' | 'all';
type EmbedStep = { from: number; to: number; blockId: string };
type Result = { key: string; tabId?: string; embedPath?: EmbedStep[]; blockId: string | null; title: string; label: string; kind: 'content' | 'title' | 'label' | 'math' | 'visibleTitle'; content: string; match: TextMatch; view?: EditorView; occurrenceKey?: string; target?: HTMLElement; sourceRange?: TextMatch; displayContent?: string; displayMatch?: TextMatch };
type CachedNoteMatches = { content: string | undefined; title: string; label: string; results: Result[] };

function visibleSource(content: string, links: ReadonlyArray<{ from: number; to: number }>) {
    const chars = content.split('');
    for (const explanation of parseMathExplanations(content)) {
        for (let at = explanation.contentFrom; at < explanation.contentTo; at++) if (chars[at] !== '\n') chars[at] = '\0';
    }
    for (const link of links) {
        for (let at = link.from; at < link.to; at++) if (chars[at] !== '\n') chars[at] = '\0';
    }
    return chars.join('');
}

function documentPosition(result: Result): number[] {
    const position = result.kind === 'title' ? -1 : result.sourceRange?.from ?? result.match.from;
    if (result.embedPath) return [...result.embedPath.map(step => step.from), position];
    const path = [position];
    let editor = result.view?.dom as HTMLElement | undefined;
    while (editor) {
        const body = editor.closest<HTMLElement>('.cm-embedded-block-wrapper[data-embed-part="body"]');
        const parent = body?.parentElement?.closest<HTMLElement>('.cm-editor');
        if (!body || !parent) break;
        path.unshift(Number(body.dataset.embedFrom));
        editor = parent;
    }
    return path;
}

function renderedMathText(tex: string, macros: Record<string, string>): string {
    try {
        const explanations = parseMathExplanations(tex);
        for (let index = explanations.length - 1; index >= 0; index--) {
            const explanation = explanations[index];
            tex = tex.slice(0, explanation.from) + explanation.math + tex.slice(explanation.to);
        }
        const host = document.createElement('span');
        host.innerHTML = katex.renderToString(tex, { throwOnError: false, macros });
        return host.querySelector<HTMLElement>('.katex-html')?.textContent || '';
    } catch { return ''; }
}

function compareDocumentPosition(a: Result, b: Result): number {
    const first = documentPosition(a);
    const second = documentPosition(b);
    for (let i = 0; i < Math.min(first.length, second.length); i++) {
        if (first[i] !== second[i]) return first[i] - second[i];
    }
    return first.length - second.length || a.key.localeCompare(b.key);
}

function ResultExcerpt({ content, match }: { content: string; match: TextMatch }) {
    const excerpt = matchExcerpt(content, match);
    return <>{excerpt.before}<mark className="rounded bg-accent/45 px-0.5 font-semibold text-primary">{excerpt.matched}</mark>{excerpt.after}</>;
}

function visibleEditors(): { view: EditorView; tabId?: string; blockId: string | null; title: string; occurrenceKey?: string }[] {
    const activePanel = document.querySelector<HTMLElement>('[role="tabpanel"][aria-hidden="false"]');
    const roots = [activePanel, ...document.querySelectorAll<HTMLElement>('.math-explanation-popover')].filter(Boolean) as HTMLElement[];
    const result: { view: EditorView; tabId?: string; blockId: string | null; title: string; occurrenceKey?: string }[] = [];
    for (const root of roots) for (const host of root.querySelectorAll<HTMLElement>('[data-find-label]')) {
        if (!host.getClientRects().length) continue;
        // findFromDOM searches descendants before the node itself. Passing a
        // parent .cm-content can accidentally return a nested embedded editor.
        const editor = host.querySelector<HTMLElement>('.cm-editor');
        const view = editor && EditorView.findFromDOM(editor);
        if (!view) continue;
        const explanation = !!host.closest('.math-explanation-popover');
        const label = host.dataset.findLabel || '';
        const store = useStore.getState();
        const id = explanation ? null : store.blockIdByLabel[label] || null;
        const panelId = host.closest<HTMLElement>('[id^="block-tab-panel-"]')?.id;
        const tabId = panelId?.slice('block-tab-panel-'.length) || store.activeTab || undefined;
        const occurrenceKey = host.closest<HTMLElement>('.cm-embedded-block-wrapper[data-embed-part="body"]')?.dataset.widgetOccurrenceKey;
        result.push({ view, tabId, blockId: id, title: explanation ? 'Open explanation' : store.blocksById[id || '']?.title || label || 'Current view', occurrenceKey });
    }
    return result;
}

export function FindPanel({ onClose }: { onClose: () => void }) {
    const [query, setQuery] = useState('');
    const [indexedQuery, setIndexedQuery] = useState('');
    const [scope, setScope] = useState<Scope>('visible');
    const [caseSensitive, setCaseSensitive] = useState(false);
    const [wholeWord, setWholeWord] = useState(false);
    const [selectedKey, setSelectedKey] = useState<string | null>(null);
    const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
    const [loadedRevision, setLoadedRevision] = useState(0);
    const [visibleRevision, setVisibleRevision] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const resultListRef = useRef<HTMLDivElement>(null);
    const pendingEnterRef = useRef<'next' | 'previous' | null>(null);
    const allMatchesCacheRef = useRef<{ query: string; caseSensitive: boolean; wholeWord: boolean; notes: Map<string, CachedNoteMatches> } | null>(null);
    const selectedViewRef = useRef<EditorView | null>(null);
    const selectedRangeRef = useRef<TextMatch | null>(null);
    const selectedElementRef = useRef<HTMLElement | null>(null);
    const hasMetadataHighlightRef = useRef(false);
    const navigationEpochRef = useRef(0);
    const blocks = useStore(state => state.blocksById);
    const blockOrder = useStore(state => state.blockOrder);
    const activeTab = useStore(state => state.activeTab);
    const openTabs = useStore(state => state.openTabs);
    const workspaceRevision = useStore(state => state.workspaceRevision);
    const blocksRef = useRef(blocks);
    blocksRef.current = blocks;
    const liveViews = useMemo(() => scope === 'visible' ? visibleEditors() : [], [scope, visibleRevision, activeTab, blocks]);
    const effectiveQuery = scope === 'visible' ? query : indexedQuery;
    const queryIsSettling = query !== effectiveQuery;

    useEffect(() => {
        if (scope === 'visible') { setIndexedQuery(query); return; }
        const timer = window.setTimeout(() => setIndexedQuery(query), 120);
        return () => window.clearTimeout(timer);
    }, [query, scope]);

    const loadIds = useMemo(() => {
        if (scope === 'all') return blockOrder;
        return scope === 'tabs' ? openTabs : [];
    }, [scope, blockOrder, openTabs]);
    const tabBlocks = scope === 'tabs' ? blocks : null;

    const clearSelectedHighlight = () => {
        const previous = selectedViewRef.current;
        const range = selectedRangeRef.current;
        if (previous?.dom.isConnected) previous.dispatch({ effects: setFindHighlight.of(null) });
        if (previous?.dom.isConnected && range && previous.state.selection.main.from === range.from && previous.state.selection.main.to === range.to) {
            previous.dispatch({ selection: { anchor: range.to } });
        }
        selectedViewRef.current?.dom.classList.remove('cm-find-target');
        selectedElementRef.current?.classList.remove('cm-find-current-math', 'cm-find-current-metadata');
        if (hasMetadataHighlightRef.current) {
            (CSS as unknown as { highlights?: Map<string, unknown> }).highlights?.delete('content-find-target');
            hasMetadataHighlightRef.current = false;
        }
        selectedViewRef.current = null;
        selectedRangeRef.current = null;
        selectedElementRef.current = null;
    };

    useEffect(() => { inputRef.current?.focus(); }, []);
    useEffect(() => () => {
        clearSelectedHighlight();
    }, []);
    useEffect(() => { setScope('visible'); setSelectedKey(null); }, [workspaceRevision]);
    useEffect(() => {
        if (scope !== 'visible') return;
        const observer = new MutationObserver(records => {
            const editorChanged = records.some(record => [...record.addedNodes, ...record.removedNodes].some(node =>
                node instanceof Element && (node.matches('[data-find-label], .cm-editor, .math-explanation-popover') ||
                    !!node.querySelector('[data-find-label], .cm-editor, .math-explanation-popover'))));
            if (editorChanged) setVisibleRevision(value => value + 1);
        });
        observer.observe(document.body, { childList: true, subtree: true });
        return () => observer.disconnect();
    }, [scope, activeTab]);
    useEffect(() => {
        resetContentFindCache(workspaceRevision);
        if (!indexedQuery || scope === 'visible') { setProgress(null); return; }
        const indexedBlocks = blocksRef.current;
        let cancelled = false;
        const seen = new Set<string>();
        const missing: string[] = [];
        const visit = (id: string) => {
            const block = indexedBlocks[id];
            if (!block || seen.has(id)) return;
            seen.add(id);
            const body = block.content ?? cachedBody(id);
            if (body === undefined) { missing.push(id); return; }
            if (scope === 'tabs') visitLinks(body, block.label);
        };
        const visitLinks = (body: string, parentLabel: string) => {
            for (const link of parseEmbeddedLinks(body)) {
                if (!link.open) continue;
                const childId = useStore.getState().blockIdByLabel[resolveEmbeddedLabel(link, parentLabel)];
                if (childId) visit(childId);
            }
        };
        loadIds.forEach(visit);
        if (!missing.length) { setProgress(null); return; }
        let next = 0;
        let done = 0;
        setProgress({ done: 0, total: missing.length });
        const worker = async () => {
            while (!cancelled && next < missing.length) {
                const id = missing[next++];
                let body: string | null = null;
                try { body = await readIndexedBody(id, workspaceRevision); } catch { /* individual unreadable note is skipped */ }
                if (!cancelled) {
                    if (body && scope === 'tabs') visitLinks(body, indexedBlocks[id].label);
                    done++;
                    setProgress({ done, total: missing.length });
                    setLoadedRevision(value => value + 1);
                }
            }
        };
        void Promise.all(Array.from({ length: Math.min(4, missing.length) }, worker)).then(() => { if (!cancelled) setProgress(null); });
        return () => { cancelled = true; };
    }, [scope, indexedQuery !== '', loadIds, tabBlocks, workspaceRevision]);

    const results = useMemo(() => {
        if (!effectiveQuery || queryIsSettling) return [] as Result[];
        if (scope === 'tabs') {
            const found: Result[] = [];
            const macros = useStore.getState().settings?.macros || {};
            const byLabel = useStore.getState().blockIdByLabel;
            const visit = (tabId: string, blockId: string, embedPath: EmbedStep[], ancestors: Set<string>) => {
                if (ancestors.has(blockId)) return;
                const block = blocks[blockId];
                if (!block) return;
                const content = block.content ?? cachedBody(blockId);
                const prefix = `${tabId}:${embedPath.map(step => step.from).join('.')}:${blockId}`;
                const title = block.title || block.label;
                if (!embedPath.length) {
                    const match = findTextMatches(title, effectiveQuery, caseSensitive, wholeWord, 1)[0];
                    if (match) found.push({ key: `${prefix}:title`, tabId, embedPath, blockId, title, label: block.label, kind: 'title', content: title, match });
                }
                if (content === undefined) return;
                const links = parseEmbeddedLinks(content);
                const sourceMatches = findTextMatches(visibleSource(content, links), effectiveQuery, caseSensitive, wholeWord, 200);
                for (const match of sourceMatches) found.push({ key: `${prefix}:content:${match.from}`, tabId, embedPath, blockId, title, label: block.label, kind: 'content', content, match });
                for (const link of links) {
                    const childId = byLabel[resolveEmbeddedLabel(link, block.label)];
                    const child = childId ? blocks[childId] : undefined;
                    const displayed = link.alias ?? child?.title ?? '';
                    const match = findTextMatches(displayed, effectiveQuery, caseSensitive, wholeWord, 1)[0];
                    if (match) found.push({ key: `${prefix}:link:${link.from}`, tabId, embedPath, blockId, title: displayed, label: block.label, kind: 'visibleTitle', content: displayed, match, sourceRange: { from: link.from, to: link.to } });
                    if (link.open && childId) visit(tabId, childId, [...embedPath, { from: link.from, to: link.to, blockId: childId }], new Set(ancestors).add(blockId));
                }
                for (const range of parseRanges(content)) {
                    if (range.type !== 'inlineMath' && range.type !== 'blockMath') continue;
                    if (sourceMatches.some(match => match.from >= range.from && match.to <= range.to)) continue;
                    const displayed = renderedMathText(range.text, macros);
                    const displayMatch = findTextMatches(displayed, effectiveQuery, caseSensitive, wholeWord, 1)[0];
                    if (displayMatch) found.push({ key: `${prefix}:math:${range.from}`, tabId, embedPath, blockId, title, label: block.label, kind: 'math', content, match: { from: range.from, to: range.to }, displayContent: displayed, displayMatch });
                }
            };
            openTabs.forEach(id => visit(id, id, [], new Set()));
            return found.sort((a, b) => openTabs.indexOf(a.tabId || '') - openTabs.indexOf(b.tabId || '') || compareDocumentPosition(a, b)).slice(0, 1000);
        }
        if (scope === 'visible') return liveViews.flatMap(({ view, tabId, blockId, title, occurrenceKey }, index) => {
            const block = blockId ? blocks[blockId] : undefined;
            const label = block?.label || '';
            const content = view.state.doc.toString();
            const links = view.state.field(parsedLinksField, false) || [];
            const sourceMatches = findTextMatches(visibleSource(content, links), effectiveQuery, caseSensitive, wholeWord, 200);
            const found: Result[] = sourceMatches.map(match => ({ key: `v:${index}:${match.from}`, tabId, blockId, title, label, kind: 'content', content, match, view, occurrenceKey }));
            const editorElement = view.dom as HTMLElement;
            const host = editorElement.closest<HTMLElement>('[data-find-label]');
            if (block && host?.dataset.findRoot === 'true') {
                const target = host.closest<HTMLElement>('[data-block-root]')?.querySelector<HTMLElement>('[data-find-visible-title]');
                const displayed = target?.innerText.trim() || '';
                const match = findTextMatches(displayed, effectiveQuery, caseSensitive, wholeWord, 1)[0];
                if (target && match) found.push({ key: `meta:${index}:title`, tabId, blockId, title, label, kind: 'title', content: displayed, match, view, target });
            }
            for (const link of links) {
                const wrapper = [...editorElement.querySelectorAll<HTMLElement>('.cm-embedded-block-wrapper[data-embed-part="title"], .cm-embedded-block-wrapper[data-embed-part="full"]')]
                    .find(candidate => Number(candidate.dataset.embedFrom) === link.from && Number(candidate.dataset.embedTo) === link.to && candidate.closest('.cm-editor') === editorElement);
                const target = wrapper?.querySelector<HTMLElement>('[data-embed-nav-title]');
                const targetLabel = resolveEmbeddedLabel(link, label);
                const targetId = useStore.getState().blockIdByLabel[targetLabel];
                const displayed = target?.innerText.trim() || (targetId ? link.alias ?? blocks[targetId]?.title ?? '' : '');
                const match = findTextMatches(displayed, effectiveQuery, caseSensitive, wholeWord, 1)[0];
                if (!match) continue;
                const sourceRange = { from: link.from, to: link.to };
                found.push({ key: `link-title:${index}:${sourceRange.from}`, tabId, blockId, title: displayed, label, kind: 'visibleTitle', content: displayed, match, view, occurrenceKey, target, sourceRange });
            }
            const ranges = view.state.field(parsedRangesField, false) || [];
            for (const widget of (view.dom as HTMLElement).querySelectorAll<HTMLElement>('.cm-math-inline, .cm-math-block')) {
                const rendered = widget.querySelector<HTMLElement>('.katex-html');
                const renderedText = rendered?.textContent || '';
                const displayMatch = findTextMatches(renderedText, effectiveQuery, caseSensitive, wholeWord, 1)[0];
                if (!rendered || !displayMatch) continue;
                let position: number;
                try { position = view.posAtDOM(widget); } catch { continue; }
                const range = ranges.find(item => (item.type === 'inlineMath' || item.type === 'blockMath') && item.from <= position && position <= item.to);
                if (!range || sourceMatches.some(match => match.from >= range.from && match.to <= range.to) || found.some(item => item.key === `rendered:${index}:${range.from}`)) continue;
                found.push({ key: `rendered:${index}:${range.from}`, tabId, blockId, title, label, kind: 'math', content, match: { from: range.from, to: range.to }, view, occurrenceKey, target: widget, displayContent: renderedText, displayMatch });
            }
            return found;
        }).sort((a, b) => (scope === 'tabs' ? openTabs.indexOf(a.tabId || '') - openTabs.indexOf(b.tabId || '') : 0) || compareDocumentPosition(a, b));
        let cache = allMatchesCacheRef.current;
        if (!cache || cache.query !== effectiveQuery || cache.caseSensitive !== caseSensitive || cache.wholeWord !== wholeWord) {
            cache = { query: effectiveQuery, caseSensitive, wholeWord, notes: new Map() };
            allMatchesCacheRef.current = cache;
        }
        const found: Result[] = [];
        for (const id of blockOrder) {
            const block = blocks[id];
            if (!block) continue;
            const content = block.content ?? cachedBody(id);
            const title = block.title || block.label;
            const previous = cache.notes.get(id);
            if (previous && previous.content === content && previous.title === block.title && previous.label === block.label) {
                found.push(...previous.results);
                if (found.length >= 1000) break;
                continue;
            }
            const titleMatch = findTextMatches(block.title, effectiveQuery, caseSensitive, wholeWord, 1)[0];
            const labelMatch = findTextMatches(block.label, effectiveQuery, caseSensitive, wholeWord, 1)[0];
            const metadata: Result[] = [];
            if (titleMatch) metadata.push({
                key: `${id}:title`, blockId: id, title, label: block.label, kind: 'title', content: block.title, match: titleMatch
            });
            if (labelMatch) metadata.push({
                key: `${id}:label`, blockId: id, title, label: block.label, kind: 'label', content: block.label, match: labelMatch
            });
            const noteResults = content === undefined ? metadata : [...metadata, ...findTextMatches(content, effectiveQuery, caseSensitive, wholeWord, 200).map(match => ({
                key: `${id}:content:${match.from}`, blockId: id, title, label: block.label, kind: 'content' as const, content, match
            }))];
            cache.notes.set(id, { content, title: block.title, label: block.label, results: noteResults });
            found.push(...noteResults);
            if (found.length >= 1000) break;
        }
        return found.slice(0, 1000);
    }, [query, effectiveQuery, queryIsSettling, scope, caseSensitive, wholeWord, liveViews, blocks, blockOrder, openTabs, activeTab, loadedRevision]);

    const selected = results.findIndex(result => result.key === selectedKey);
    const rowVirtualizer = useVirtualizer({
        count: results.length,
        getScrollElement: () => resultListRef.current,
        estimateSize: () => 44,
        overscan: 5
    });
    useEffect(() => { setSelectedKey(null); clearSelectedHighlight(); }, [query, scope, caseSensitive, wholeWord]);
    useEffect(() => {
        if (selected >= 0) rowVirtualizer.scrollToIndex(selected, { align: 'auto' });
    }, [selected, rowVirtualizer]);
    useEffect(() => {
        const views = visibleEditors().map(item => item.view);
        const searchQuery = new SearchQuery({ search: queryIsSettling ? '' : effectiveQuery, caseSensitive, wholeWord });
        for (const view of views) view.dispatch({ effects: setSearchQuery.of(searchQuery) });
        return () => { for (const view of views) if (view.dom.isConnected) view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: '' })) }); };
    }, [effectiveQuery, queryIsSettling, caseSensitive, wholeWord, scope, visibleRevision, activeTab]);

    const navigate = (index: number) => {
        if (!results.length) return;
        const epoch = ++navigationEpochRef.current;
        const next = (index + results.length) % results.length;
        const result = results[next];
        setSelectedKey(result.key);
        clearSelectedHighlight();
        const currentView = () => {
            if (result.view?.dom.isConnected) return result.view;
            return visibleEditors().find(candidate => candidate.tabId === result.tabId && candidate.blockId === result.blockId &&
                candidate.occurrenceKey === result.occurrenceKey)?.view;
        };
        const highlightElement = (element: HTMLElement, className: 'cm-find-current-math' | 'cm-find-current-metadata') => {
            selectedElementRef.current = element;
            element.classList.add(className);
            element.scrollIntoView({ block: 'center' });
        };
        const visibleMetadataTarget = (view: EditorView) => {
            const host = view.dom.closest<HTMLElement>('[data-find-label]');
            if (host?.dataset.findRoot === 'true') {
                return host.closest('[data-block-root]')?.querySelector<HTMLElement>('[data-testid^="block-metadata-header-"]') || null;
            }
            const body = host?.closest<HTMLElement>('.cm-embedded-block-wrapper[data-embed-part="body"]');
            if (!body) return null;
            const parentEditor = body.closest<HTMLElement>('.cm-editor');
            const title = [...(parentEditor?.querySelectorAll<HTMLElement>('.cm-embedded-block-wrapper[data-embed-part="title"]') || [])]
                .find(candidate => candidate.dataset.embedFrom === body.dataset.embedFrom &&
                    candidate.dataset.embedTo === body.dataset.embedTo && candidate.closest('.cm-editor') === parentEditor);
            return title?.querySelector<HTMLElement>('[data-embed-nav-title]') || body;
        };
        const renderedLinkTitle = (view: EditorView) => {
            const link = view.state.field(parsedLinksField, false)?.find(candidate =>
                candidate.from <= result.match.from && result.match.to <= candidate.to);
            if (!link) return null;
            const wrapper = [...view.dom.querySelectorAll<HTMLElement>('.cm-embedded-block-wrapper[data-embed-part="title"]')]
                .find(candidate => Number(candidate.dataset.embedFrom) === link.from &&
                    Number(candidate.dataset.embedTo) === link.to && candidate.closest('.cm-editor') === view.dom);
            return wrapper?.querySelector<HTMLElement>('[data-embed-nav-title]') || null;
        };
        const reveal = (view: EditorView, keepEditorSelection = false) => {
            const doc = view.state.doc.toString();
            let match = result.match;
            if (doc !== result.content) {
                const candidates = findTextMatches(doc, effectiveQuery, caseSensitive, wholeWord);
                if (!candidates.length) return;
                match = candidates.reduce((closest, candidate) => Math.abs(candidate.from - result.match.from) < Math.abs(closest.from - result.match.from) ? candidate : closest);
            }
            selectedViewRef.current = view;
            selectedRangeRef.current = keepEditorSelection ? null : match;
            view.dom.classList.add('cm-find-target');
            if (keepEditorSelection) {
                view.dispatch({ effects: [setFindHighlight.of(match), EditorView.scrollIntoView(match.from, { y: 'center' })] });
            } else view.dispatch({ selection: { anchor: match.from, head: match.to }, scrollIntoView: true });
        };
        const highlightMetadataMatch = (target: HTMLElement) => {
            highlightElement(target, 'cm-find-current-metadata');
            const parts: { node: Text; from: number; to: number }[] = [];
            const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
            let display = '';
            while (walker.nextNode()) {
                const node = walker.currentNode as Text;
                if (node.parentElement?.closest('.katex-mathml,[aria-hidden="true"]')) continue;
                parts.push({ node, from: display.length, to: display.length + node.data.length });
                display += node.data;
            }
            const match = findTextMatches(display, effectiveQuery, caseSensitive, wholeWord, 1)[0];
            if (!match) return;
            const start = parts.find(part => part.from <= match.from && part.to > match.from);
            const end = parts.find(part => part.from < match.to && part.to >= match.to);
            const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
            const Constructor = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
            if (!start || !end || !registry || !Constructor) return;
            const range = document.createRange();
            range.setStart(start.node, match.from - start.from);
            range.setEnd(end.node, match.to - end.from);
            registry.set('content-find-target', new Constructor(range));
            hasMetadataHighlightRef.current = true;
        };
        const navigateInView = (resolvedView?: EditorView) => {
            if (epoch !== navigationEpochRef.current) return;
            const view = resolvedView || currentView();
            if (!view) return;
            if (result.kind === 'title' || result.kind === 'label' || result.kind === 'visibleTitle') {
                const findVisibleTitle = () => [...view.dom.querySelectorAll<HTMLElement>('.cm-embedded-block-wrapper[data-embed-part="title"], .cm-embedded-block-wrapper[data-embed-part="full"]')]
                    .find(wrapper => Number(wrapper.dataset.embedFrom) === result.sourceRange?.from && Number(wrapper.dataset.embedTo) === result.sourceRange?.to && wrapper.closest('.cm-editor') === view.dom)
                    ?.querySelector<HTMLElement>('[data-embed-nav-title]');
                const target = result.target?.isConnected ? result.target : result.kind === 'visibleTitle' ? findVisibleTitle() : visibleMetadataTarget(view);
                if (target) highlightElement(target, 'cm-find-current-metadata');
                else if (result.kind === 'visibleTitle' && result.sourceRange) {
                    view.dispatch({ effects: EditorView.scrollIntoView(result.sourceRange.from, { y: 'center' }) });
                    let attempts = 0;
                    const seekTitle = () => {
                        if (epoch !== navigationEpochRef.current) return;
                        const mounted = findVisibleTitle();
                        if (mounted) highlightElement(mounted, 'cm-find-current-metadata');
                        else if (++attempts < 20) window.setTimeout(seekTitle, 50);
                    };
                    window.setTimeout(seekTitle, 0);
                }
                return;
            }
            if (result.kind === 'math') {
                const target = result.target?.isConnected ? result.target : [...view.dom.querySelectorAll<HTMLElement>('.cm-math-inline, .cm-math-block')]
                    .find(widget => {
                        try {
                            const position = view.posAtDOM(widget);
                            return position >= result.match.from && position <= result.match.to;
                        } catch { return false; }
                    });
                if (target) highlightElement(target, 'cm-find-current-math');
                else {
                    selectedViewRef.current = view;
                    view.dom.classList.add('cm-find-target');
                    view.dispatch({ selection: { anchor: result.match.from, head: result.match.to }, scrollIntoView: true });
                }
                return;
            }
            const linkTitle = renderedLinkTitle(view);
            if (linkTitle) {
                highlightElement(linkTitle, 'cm-find-current-metadata');
                return;
            }
            reveal(view);
            return;
        };
        if (scope === 'visible' || scope === 'tabs') {
            if (scope === 'tabs' && result.tabId) {
                if (useStore.getState().activeTab !== result.tabId) useStore.getState().activateTab(result.tabId);
                useStore.getState().setActiveBlock(null);
                let attempts = 0;
                const seekTabView = () => {
                    if (epoch !== navigationEpochRef.current) return;
                    const panel = document.querySelector<HTMLElement>(`#block-tab-panel-${CSS.escape(result.tabId!)}`);
                    const root = panel?.querySelector<HTMLElement>('[data-find-root="true"] .cm-editor');
                    let view = root && EditorView.findFromDOM(root);
                    let missingStep: EmbedStep | undefined;
                    for (const step of result.embedPath || []) {
                        if (!view) break;
                        const parentView = view;
                        const body = [...parentView.dom.querySelectorAll<HTMLElement>('.cm-embedded-block-wrapper[data-embed-part="body"]')]
                            .find(wrapper => Number(wrapper.dataset.embedFrom) === step.from && Number(wrapper.dataset.embedTo) === step.to && wrapper.closest('.cm-editor') === parentView.dom);
                        const editor = body?.querySelector<HTMLElement>('[data-find-label] .cm-editor');
                        view = editor && EditorView.findFromDOM(editor);
                        if (!view) { missingStep = step; parentView.dispatch({ effects: EditorView.scrollIntoView(step.from, { y: 'center' }) }); break; }
                    }
                    if (view && !missingStep) navigateInView(view);
                    else if (++attempts < 40) window.setTimeout(seekTabView, 75);
                };
                window.setTimeout(seekTabView, 0);
            } else navigateInView();
            return;
        }
        if (!result.blockId) return;
        useStore.getState().activateRootBlock(result.blockId);
        useStore.getState().setActiveBlock(null);
        // The root editor may mount after its note is loaded.
        let attempts = 0;
        const seek = () => {
            if (epoch !== navigationEpochRef.current) return;
            const panel = document.querySelector<HTMLElement>(`#block-tab-panel-${CSS.escape(result.blockId!)}`);
            const editor = panel?.querySelector<HTMLElement>('[data-find-root="true"] .cm-editor');
            const view = editor && EditorView.findFromDOM(editor);
            if (view) {
                if (result.kind === 'title' || result.kind === 'label') {
                    const target = panel?.querySelector<HTMLElement>(result.kind === 'title' ? '[data-find-visible-title]' : '[data-find-visible-label]');
                    if (target) highlightMetadataMatch(target);
                    inputRef.current?.focus({ preventScroll: true });
                    return;
                }
                reveal(view, true);
                inputRef.current?.focus({ preventScroll: true });
                return;
            }
            if (++attempts < 40) window.setTimeout(seek, 75);
        };
        window.setTimeout(seek, 0);
    };

    useEffect(() => {
        const direction = pendingEnterRef.current;
        if (!direction || queryIsSettling || !results.length) return;
        pendingEnterRef.current = null;
        navigate(direction === 'next' ? 0 : results.length - 1);
    }, [queryIsSettling, results]);

    return <aside className="fixed right-4 top-16 z-[150] w-[min(30rem,calc(100vw-2rem))] rounded-xl border border-outline bg-surface shadow-2xl text-primary" role="search" aria-label="Find in notes" data-testid="content-find-panel">
        <div className="flex items-center gap-1 p-2">
            <input ref={inputRef} value={query} placeholder="Find in content…" aria-label="Find in content"
                className="min-w-0 flex-1 rounded-md bg-base px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-accent"
                onChange={event => { pendingEnterRef.current = null; setQuery(event.target.value); }}
                onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); if (queryIsSettling) { pendingEnterRef.current = event.shiftKey ? 'previous' : 'next'; setIndexedQuery(query); } else navigate(selected < 0 ? (event.shiftKey ? results.length - 1 : 0) : selected + (event.shiftKey ? -1 : 1)); } else if (event.key === 'Escape') { event.preventDefault(); onClose(); } }} />
            <span className="min-w-12 text-center text-xs text-secondary">{query ? `${selected < 0 ? 0 : selected + 1}/${results.length}${progress ? '+' : ''}` : ''}</span>
            <button type="button" aria-label="Previous match" title="Previous match" onClick={() => navigate(selected < 0 ? results.length - 1 : selected - 1)} disabled={!results.length} className="rounded p-1 hover:bg-outline disabled:opacity-40"><ChevronUp size={16}/></button>
            <button type="button" aria-label="Next match" title="Next match" onClick={() => navigate(selected + 1)} disabled={!results.length} className="rounded p-1 hover:bg-outline disabled:opacity-40"><ChevronDown size={16}/></button>
            <button type="button" aria-label="Close find" onClick={onClose} className="rounded p-1 hover:bg-outline"><X size={16}/></button>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-outline px-3 py-2 text-xs">
            <label className="text-secondary">Scope <select value={scope} onChange={event => setScope(event.target.value as Scope)} aria-label="Search scope" className="ml-1 rounded border border-outline bg-base px-1 py-1 text-primary">
                <option value="visible">Current view</option><option value="tabs">Open tabs</option><option value="all">All notes</option>
            </select></label>
            <button type="button" aria-pressed={caseSensitive} onClick={() => setCaseSensitive(value => !value)} className={`rounded px-1.5 py-1 ${caseSensitive ? 'bg-accent/20 text-accent' : 'text-secondary hover:bg-outline'}`} title="Match case">Aa</button>
            <button type="button" aria-pressed={wholeWord} onClick={() => setWholeWord(value => !value)} className={`rounded px-1.5 py-1 ${wholeWord ? 'bg-accent/20 text-accent' : 'text-secondary hover:bg-outline'}`} title="Whole word">Word</button>
            {progress && <span className="ml-auto text-secondary" role="status">Indexing {progress.done}/{progress.total}</span>}
        </div>
        {scope === 'visible' && <p className="px-3 pb-2 text-[11px] text-secondary">Displayed text and titles in this tab, including expanded notes and open explanations</p>}
        {scope === 'tabs' && <p className="px-3 pb-2 text-[11px] text-secondary">Displayed text and titles across open tabs, including expanded notes</p>}
        <div ref={resultListRef} className="max-h-[min(45vh,22rem)] overflow-y-auto border-t border-outline p-1" role="listbox" aria-label="Content search results">
            {results.length ? <div className="relative w-full" style={{ height: rowVirtualizer.getTotalSize() }}>
                {rowVirtualizer.getVirtualItems().map(row => {
                    const result = results[row.index];
                    return <button type="button" role="option" aria-selected={row.index === selected} aria-posinset={row.index + 1} aria-setsize={results.length} key={result.key} onClick={() => navigate(row.index)}
                        style={{ transform: `translateY(${row.start}px)` }}
                        className={`absolute left-0 top-0 block h-11 w-full rounded border-l-2 px-2 py-1.5 text-left text-xs hover:bg-outline ${row.index === selected ? 'border-accent bg-accent/25' : 'border-transparent'}`}>
                        <span className="block truncate font-semibold text-primary">{result.title}<span className="ml-2 font-normal text-secondary">{result.label}</span></span>
                        <span className="block truncate text-secondary">{result.kind === 'title' || result.kind === 'visibleTitle' ? 'Title: ' : result.kind === 'label' ? 'Label: ' : result.kind === 'math' ? 'Math: ' : ''}<ResultExcerpt content={result.displayContent ?? result.content} match={result.displayMatch ?? result.match} /></span>
                    </button>;
                })}
            </div> : <p className="p-3 text-center text-xs text-secondary">{!query ? 'Type to find in notes' : queryIsSettling || progress ? 'Searching notes…' : 'No matches'}</p>}
        </div>
    </aside>;
}
