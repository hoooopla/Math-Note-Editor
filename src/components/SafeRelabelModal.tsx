import React, { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowRight, Check, CheckCircle2, ChevronDown, Copy, FileText, GitBranch, Link2, Loader2, X } from "lucide-react";
import { getOrderedBlocks, useStore } from "../store";
import { RelabelChangeType, SafeRelabelPlan } from "../lib/safe-relabel";
import { splitPath } from "../lib/utils/path";

interface SafeRelabelModalProps {
    oldPrefix: string;
    newPrefix: string;
    onClose: (completed: boolean) => void;
}

const actionNames: Record<RelabelChangeType, string> = {
    "no-op": "No tree change",
    "rename-node": "Rename node",
    "insert-parent": "Insert parent",
    "remove-parent": "Remove path segment",
    "move-subtree": "Move subtree",
    "move-and-rename": "Move and rename subtree"
};

function Breadcrumb({ label }: { label: string }) {
    const [expanded, setExpanded] = useState(false);
    const parts = splitPath(label);
    const collapsed = parts.length > 4 && !expanded;
    const visible = collapsed
        ? [{ part: parts[0], index: 0 }, { part: "…", index: -1 }, ...parts.slice(-2).map((part, offset) => ({ part, index: parts.length - 2 + offset }))]
        : parts.map((part, index) => ({ part, index }));
    return <div className="flex min-w-0 flex-wrap items-center gap-1 font-mono text-xs">
        {visible.map(({ part, index }, visibleIndex) => <React.Fragment key={`${part}-${index}`}>
            {visibleIndex > 0 && <span className="text-secondary/60">/</span>}
            {index === -1
                ? <button type="button" onClick={() => setExpanded(true)} className="rounded border border-outline bg-base px-2 py-1 text-secondary hover:text-primary" aria-label={`Show complete path ${label}`} title="Show hidden ancestors">…</button>
                : <span className="max-w-52 truncate rounded border border-outline bg-base px-2 py-1 text-primary" title={part} aria-label={part}>{part || "(empty)"}</span>}
        </React.Fragment>)}
        {parts.length > 4 && expanded && <button type="button" onClick={() => setExpanded(false)} className="px-1 py-1 text-[10px] text-secondary underline hover:text-primary">Collapse</button>}
    </div>;
}

function compactMiddle(value: string, limit = 54) {
    if (value.length <= limit) return value;
    const side = Math.floor((limit - 1) / 2);
    return `${value.slice(0, side)}…${value.slice(-side)}`;
}

function PathText({ value, className = "" }: { value: string, className?: string }) {
    return <span className={className} title={value} aria-label={value}>{compactMiddle(value)}</span>;
}

function CopyPathButton({ value }: { value: string }) {
    const [copied, setCopied] = useState(false);
    const copy = async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
    };
    return <button type="button" onClick={copy} className="shrink-0 rounded p-1 text-secondary hover:bg-outline hover:text-primary" aria-label={`Copy full path ${value}`} title="Copy full path">
        {copied ? <Check size={14} className="text-emerald-300"/> : <Copy size={14}/>} 
    </button>;
}

function isPathBelow(label: string, parent: string) {
    const labelParts = splitPath(label);
    const parentParts = splitPath(parent);
    return labelParts.length > parentParts.length && parentParts.every((part, index) => labelParts[index] === part);
}

function TreeSummary({ plan, after, labels }: { plan: SafeRelabelPlan, after: boolean, labels: string[] }) {
    const prefix = after ? plan.newPrefix : plan.oldPrefix;
    const prefixParts = splitPath(prefix);
    const parentParts = prefixParts.slice(0, -1);
    const parent = parentParts.join("/");
    const parentExists = parent !== "" && labels.includes(parent);
    const parentKind = parent === "" ? "Workspace root" : parentExists ? "Existing parent" : "Inferred parent";
    const rows = plan.blockChanges.slice(0, 7).map(change => {
        const label = after ? change.newLabel : change.oldLabel;
        const suffix = splitPath(label).slice(splitPath(prefix).length);
        return { ...change, suffix };
    });
    const siblingPaths = Array.from(new Set(labels.flatMap(label => {
        const parts = splitPath(label);
        const isBelowParent = parent === "" ? parts.length > 0 : isPathBelow(label, parent);
        if (!isBelowParent || parts.length <= parentParts.length) return [];
        const siblingPath = [...parentParts, parts[parentParts.length]].join("/");
        return siblingPath === prefix ? [] : [siblingPath];
    }))).slice(0, 2);

    return <div data-testid={`safe-relabel-${after ? "after" : "before"}-tree`} className="min-w-0 rounded-lg border border-outline bg-base/60 p-3">
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-secondary">{after ? "After" : "Before"}</div>
        <div className="mb-3">
            <div className="mb-1 text-[10px] uppercase tracking-widest text-secondary/70">Full path</div>
            <Breadcrumb label={prefix}/>
        </div>
        <div className="space-y-1 font-mono text-xs">
            <div className="flex min-w-0 items-center gap-2 text-secondary">
                <PathText value={parent || "Workspace"} className="min-w-0 truncate"/>
                <span className="shrink-0 rounded border border-outline px-1.5 py-0.5 font-sans text-[9px] uppercase tracking-wider text-secondary/80">{parentKind}</span>
            </div>
            <div className={`break-words pl-3 text-sm font-semibold [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] ${after ? "text-emerald-300" : "text-accent"}`} title={prefixParts.at(-1)}>└─ {compactMiddle(prefixParts.at(-1) || "")}</div>
        </div>
        <div className="mt-2 space-y-1 font-mono text-xs text-secondary">
            {rows.filter(row => row.suffix.length > 0).map(row =>
                <div key={row.id} className="truncate" style={{ paddingLeft: `${12 + Math.min(row.suffix.length, 4) * 10}px` }}>
                    └─ <PathText value={row.suffix.join("/")}/>
                </div>
            )}
            {plan.blockChanges.length > 7 && <div className="pl-3 text-secondary/70">…and {plan.blockChanges.length - 7} more blocks</div>}
        </div>
        {after && siblingPaths.length > 0 && <div className="mt-3 border-t border-outline/70 pt-2">
            <div className="text-[10px] uppercase tracking-widest text-secondary/70">Nearby existing siblings</div>
            {siblingPaths.map(sibling => <div key={sibling} className="mt-1 truncate font-mono text-xs text-secondary" title={sibling}>├─ {compactMiddle(splitPath(sibling).at(-1) || "")}</div>)}
        </div>}
    </div>;
}

export function SafeRelabelModal({ oldPrefix, newPrefix, onClose }: SafeRelabelModalProps) {
    const blocksRevision = useStore(state => state.blocksRevision);
    const blocks = useMemo(() => getOrderedBlocks(useStore.getState()), [blocksRevision]);
    const previewRelabel = useStore(state => state.previewRelabel);
    const commitRelabel = useStore(state => state.commitRelabel);
    const [plan, setPlan] = useState<SafeRelabelPlan | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [phase, setPhase] = useState<"loading" | "preview" | "applying" | "complete">("loading");
    const [currentIndex, setCurrentIndex] = useState(0);

    useEffect(() => {
        let cancelled = false;
        setPhase("loading");
        previewRelabel(oldPrefix, newPrefix).then(next => {
            if (cancelled) return;
            setPlan(next);
            setPhase("preview");
        }).catch(reason => {
            if (cancelled) return;
            setError(reason instanceof Error ? reason.message : String(reason));
            setPhase("preview");
        });
        return () => { cancelled = true; };
    }, [newPrefix, oldPrefix, previewRelabel]);

    const changedReferences = useMemo(() => plan?.referenceImpacts.filter(impact => impact.changed) || [], [plan]);
    const stableReferences = useMemo(() => plan?.referenceImpacts.filter(impact => !impact.changed) || [], [plan]);
    const workItems = useMemo(() => {
        if (!plan) return [];
        const items = plan.blockChanges.map(change => ({
            id: change.id,
            title: change.title,
            oldLabel: change.oldLabel,
            newLabel: change.newLabel,
            fileName: change.fileName
        }));
        const included = new Set(items.map(item => item.id));
        for (const impact of plan.referenceImpacts) {
            if (!impact.changed || included.has(impact.blockId)) continue;
            included.add(impact.blockId);
            items.push({
                id: impact.blockId,
                title: impact.blockTitle,
                oldLabel: impact.sourceLabel,
                newLabel: impact.sourceLabel,
                fileName: impact.fileName
            });
        }
        return items;
    }, [plan]);
    const current = workItems[currentIndex];
    const beforeLabels = useMemo(() => blocks.map(block => block.label), [blocks]);
    const afterLabels = useMemo(() => {
        if (!plan) return beforeLabels;
        const changedLabels = new Map(plan.blockChanges.map(change => [change.id, change.newLabel]));
        return blocks.map(block => changedLabels.get(block.id) || block.label);
    }, [beforeLabels, blocks, plan]);

    useEffect(() => {
        if (phase !== "applying" || !workItems.length) return;
        const timer = window.setInterval(() => setCurrentIndex(index => (index + 1) % workItems.length), 550);
        return () => window.clearInterval(timer);
    }, [phase, workItems]);

    const apply = async () => {
        if (!plan || plan.conflicts.length) return;
        setError(null);
        setCurrentIndex(0);
        setPhase("applying");
        try {
            await commitRelabel(plan);
            setPhase("complete");
        } catch (reason) {
            const message = reason instanceof Error ? reason.message : String(reason);
            if (message.includes("workspace changed")) {
                try {
                    const refreshed = await previewRelabel(oldPrefix, newPrefix);
                    setPlan(refreshed);
                    setError("The workspace changed while the preview was open. The preview below has been refreshed; please review it again.");
                } catch {
                    setError(message);
                }
            } else {
                setError(message);
            }
            setPhase("preview");
        }
    };

    if (phase === "loading") return <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Preparing tree transformation">
        <div className="flex w-[min(92vw,420px)] flex-col items-center rounded-xl border border-outline bg-surface p-8 shadow-2xl">
            <Loader2 className="mb-4 animate-spin text-accent" size={34} />
            <div className="text-lg font-semibold text-primary">Preparing tree transformation…</div>
            <div className="mt-2 text-center text-sm text-secondary">Checking descendants, files, and embedded links.</div>
        </div>
    </div>;

    if (phase === "applying") return <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Applying tree transformation">
        <div className="w-[min(92vw,520px)] rounded-xl border border-outline bg-surface p-6 shadow-2xl">
            <div className="flex items-center gap-3"><Loader2 className="animate-spin text-accent" size={26} /><div><div className="text-lg font-semibold">Safely transforming the tree…</div><div className="text-sm text-secondary">Updating blocks and checking links</div></div></div>
            <div className="mt-5 h-1.5 overflow-hidden rounded-full bg-outline"><div className="h-full w-2/3 animate-pulse rounded-full bg-accent" /></div>
            {current && <div className="mt-5 rounded-lg border border-outline bg-base p-4">
                <div className="text-[10px] uppercase tracking-widest text-secondary">Current block</div>
                <div className="mt-1 font-semibold text-primary">{current.title}</div>
                <div className="mt-2 flex items-center gap-2 overflow-hidden font-mono text-xs text-secondary"><span className="truncate">{current.oldLabel}</span><ArrowRight className="shrink-0" size={13}/><span className="truncate text-emerald-300">{current.newLabel}</span></div>
                <div className="mt-3 flex items-center gap-2 text-xs text-secondary"><FileText size={13}/><span className="truncate">{current.fileName || `${current.title} — ${current.oldLabel}`}</span></div>
            </div>}
            <div className="mt-3 text-right text-xs text-secondary">Processing {Math.min(currentIndex + 1, workItems.length || 1)} of {workItems.length || 1}</div>
        </div>
    </div>;

    if (phase === "complete" && plan) return <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Tree transformation complete">
        <div className="w-[min(92vw,480px)] rounded-xl border border-emerald-500/30 bg-surface p-7 text-center shadow-2xl">
            <CheckCircle2 className="mx-auto text-emerald-400" size={42}/>
            <h2 className="mt-3 text-xl font-semibold">Tree transformation complete</h2>
            <div className="mt-3 flex items-center justify-center gap-2"><Breadcrumb label={plan.oldPrefix}/><ArrowRight size={15}/><Breadcrumb label={plan.newPrefix}/></div>
            <p className="mt-4 text-sm text-secondary">{plan.blockChanges.length} block label{plan.blockChanges.length === 1 ? "" : "s"} updated · {changedReferences.length} link{changedReferences.length === 1 ? "" : "s"} rewritten · {stableReferences.length} relative link{stableReferences.length === 1 ? "" : "s"} stayed valid</p>
            <button autoFocus onClick={() => onClose(true)} className="mt-6 rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-white hover:bg-accent/80">Done</button>
        </div>
    </div>;

    return <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="safe-relabel-title">
        <div className="flex max-h-[92vh] w-[min(96vw,900px)] flex-col overflow-hidden rounded-xl border border-outline bg-surface shadow-2xl">
            <div className="flex items-start justify-between border-b border-outline px-6 py-5">
                <div><div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-accent"><GitBranch size={15}/>Tree transformation</div><h2 id="safe-relabel-title" className="text-xl font-semibold">{plan ? actionNames[plan.changeType] : "Review change"}</h2><p className="mt-1 text-sm text-secondary">Labels and links are the stored consequences of this structural change.</p></div>
                <button onClick={() => onClose(false)} className="rounded p-1 text-secondary hover:bg-outline hover:text-primary" aria-label="Close tree transformation"><X size={20}/></button>
            </div>
            <div className="overflow-y-auto px-6 py-5">
                <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-center"><div><div className="mb-1 text-[10px] uppercase tracking-widest text-secondary">From</div><Breadcrumb label={oldPrefix}/></div><ArrowRight className="hidden text-secondary sm:block" size={18}/><div><div className="mb-1 text-[10px] uppercase tracking-widest text-secondary">To</div><Breadcrumb label={newPrefix}/></div></div>
                {error && <div className="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">{error}</div>}
                {plan && <>
                    <div className="mt-5 grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-center"><TreeSummary plan={plan} after={false} labels={beforeLabels}/><ArrowRight className="mx-auto rotate-90 text-secondary sm:rotate-0" size={18}/><TreeSummary plan={plan} after labels={afterLabels}/></div>
                    <details data-testid="safe-relabel-complete-paths" className="mt-3 rounded-lg border border-outline">
                        <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">Show complete paths</summary>
                        <div className="space-y-3 border-t border-outline p-3">
                            {[["Before", plan.oldPrefix], ["After", plan.newPrefix]].map(([name, value]) => <div key={name}>
                                <div className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-secondary">{name}</div>
                                <div className="flex items-center gap-2 rounded bg-base p-2">
                                    <code className="min-w-0 flex-1 select-text overflow-x-auto whitespace-nowrap text-xs text-primary">{value}</code>
                                    <CopyPathButton value={value}/>
                                </div>
                            </div>)}
                        </div>
                    </details>
                    <div className="mt-4 flex flex-wrap gap-2 text-xs"><span className="rounded-full border border-outline px-3 py-1">{plan.blockChanges.length} blocks</span><span className="rounded-full border border-outline px-3 py-1">{changedReferences.length} links rewritten</span><span className="rounded-full border border-outline px-3 py-1">{stableReferences.length} relative links remain valid</span></div>
                    {plan.conflicts.length > 0 && <div className="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 p-4"><div className="flex items-center gap-2 font-semibold text-red-300"><AlertTriangle size={17}/>Cannot apply this transformation</div>{plan.conflicts.map(conflict => <div key={conflict} className="mt-2 text-sm text-red-200">{conflict}</div>)}</div>}
                    {plan.warnings.map(warning => <div key={warning} className="mt-4 flex gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-200"><AlertTriangle className="mt-0.5 shrink-0" size={16}/>{warning}</div>)}
                    <details className="mt-5 rounded-lg border border-outline" open><summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 font-semibold"><ChevronDown size={16}/><GitBranch size={16} className="text-accent"/>Block label changes <span className="ml-auto text-xs font-normal text-secondary">{plan.blockChanges.length}</span></summary><div className="max-h-52 space-y-2 overflow-y-auto border-t border-outline p-3">{plan.blockChanges.map(change => <div key={change.id} className="rounded bg-base p-3"><div className="text-sm font-semibold">{change.title}</div><div className="mt-1 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 font-mono text-xs text-secondary"><PathText value={change.oldLabel} className="truncate"/><ArrowRight className="shrink-0" size={12}/><PathText value={change.newLabel} className="truncate text-emerald-300"/></div></div>)}</div></details>
                    <details className="mt-3 rounded-lg border border-outline" open={changedReferences.length > 0}><summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 font-semibold"><ChevronDown size={16}/><Link2 size={16} className="text-accent"/>Link effects <span className="ml-auto text-xs font-normal text-secondary">{plan.referenceImpacts.length} checked</span></summary><div className="max-h-72 space-y-3 overflow-y-auto border-t border-outline p-3">{plan.referenceImpacts.length === 0 && <div className="p-2 text-sm text-secondary">No embedded links are affected.</div>}{plan.referenceImpacts.map((impact, index) => <div key={`${impact.blockId}-${impact.line}-${impact.column}-${index}`} className="rounded bg-base p-3"><div className="flex items-center justify-between gap-2"><span className="text-sm font-semibold">{impact.blockTitle}</span><span className={`text-[10px] font-semibold uppercase tracking-wider ${impact.changed ? "text-amber-300" : "text-emerald-300"}`}>{impact.changed ? "Rewritten" : "Still valid"}</span></div><div className="mt-1 text-xs text-secondary">Line {impact.line}, column {impact.column}{!impact.targetExists ? " · unresolved target" : ""}</div><pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded border border-outline p-2 font-mono text-xs text-secondary">{impact.contextBefore}</pre>{impact.changed && <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded border border-emerald-500/20 bg-emerald-500/5 p-2 font-mono text-xs text-emerald-200">{impact.contextAfter}</pre>}{!impact.changed && <div className="mt-2 text-xs text-secondary">The relative link moves with its source and still resolves to the same child.</div>}</div>)}</div></details>
                </>}
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-outline px-6 py-4"><div className="text-xs text-secondary">No blocks will be deleted.</div><div className="flex gap-2"><button onClick={() => onClose(false)} className="rounded-lg border border-outline px-4 py-2 text-sm hover:bg-outline">Cancel</button><button onClick={apply} disabled={!plan || plan.conflicts.length > 0 || plan.changeType === "no-op"} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent/80 disabled:cursor-not-allowed disabled:opacity-40">{plan ? actionNames[plan.changeType] : "Apply"}</button></div></div>
        </div>
    </div>;
}
