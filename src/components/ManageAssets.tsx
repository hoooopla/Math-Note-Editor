import React, { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Folder, Search } from 'lucide-react';
import { useStore } from '../store';
import { AssetMovePlan } from '../lib/safe-asset-move';
import { validateAssetPath } from '../lib/asset-reference';

const imageFile = (path: string) => /\.(?:png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(path);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function ManageAssets() {
    const backendMode = useStore(state => state.backendMode);
    const assetRevision = useStore(state => state.assetRevision);
    const listAssets = useStore(state => state.listAssets);
    const getAssetUrl = useStore(state => state.getAssetUrl);
    const previewAssetMove = useStore(state => state.previewAssetMove);
    const commitAssetMove = useStore(state => state.commitAssetMove);
    const [assets, setAssets] = useState<string[]>([]);
    const [folder, setFolder] = useState('');
    const [search, setSearch] = useState('');
    const [selected, setSelected] = useState('');
    const [destination, setDestination] = useState('');
    const [plan, setPlan] = useState<AssetMovePlan | null>(null);
    const [previewUrl, setPreviewUrl] = useState('');
    const [dimensions, setDimensions] = useState('');
    const [fileSize, setFileSize] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [status, setStatus] = useState('');

    useEffect(() => {
        let active = true;
        listAssets().then(paths => {
            if (active) setAssets(paths.map(path => path.startsWith('assets/') ? path.slice(7) : path).filter(imageFile).sort((a, b) => a.localeCompare(b)));
        }).catch(failure => { if (active) setError(message(failure)); });
        return () => { active = false; };
    }, [listAssets, assetRevision]);

    useEffect(() => {
        setPreviewUrl('');
        setDimensions('');
        setFileSize('');
        if (!selected || !imageFile(selected)) return;
        let active = true;
        let ownedUrl = '';
        getAssetUrl(`assets/${selected}`).then(async url => {
            if (!active) { if (url.startsWith('blob:')) URL.revokeObjectURL(url); return; }
            ownedUrl = url.startsWith('blob:') ? url : '';
            setPreviewUrl(url);
            try {
                const blob = await (await fetch(url)).blob();
                if (active) setFileSize(`${(blob.size / 1024).toFixed(1)} KB`);
            } catch { /* Preview is still useful when metadata cannot be read. */ }
        }).catch(failure => { if (active) setError(message(failure)); });
        return () => { active = false; if (ownedUrl) URL.revokeObjectURL(ownedUrl); };
    }, [selected, getAssetUrl]);

    const folders = useMemo(() => {
        const paths = new Set<string>();
        for (const asset of assets) {
            const parts = asset.split('/');
            for (let index = 1; index < parts.length; index++) paths.add(parts.slice(0, index).join('/'));
        }
        return [...paths].sort((a, b) => a.localeCompare(b));
    }, [assets]);
    const prefix = folder ? `${folder}/` : '';
    const childFolders = folders.filter(path => path.startsWith(prefix) && path !== folder && !path.slice(prefix.length).includes('/'));
    const visible = search.trim() ? assets.filter(path => path.toLowerCase().includes(search.trim().toLowerCase()))
        : assets.filter(path => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'));
    const destinationError = validateAssetPath(destination);
    const choose = (path: string) => { setSelected(path); setDestination(path); setPlan(null); setError(''); setStatus(''); };
    const review = async () => {
        if (!selected || destinationError) return;
        setBusy(true); setError(''); setStatus(''); setPlan(null);
        try { setPlan(await previewAssetMove(`assets/${selected}`, `assets/${destination}`)); }
        catch (failure) { setError(message(failure)); }
        finally { setBusy(false); }
    };
    const commit = async () => {
        if (!plan || plan.conflicts.length) return;
        setBusy(true); setError('');
        try {
            const warning = await commitAssetMove(plan);
            setStatus(`Moved to assets/${destination}. Updated ${plan.impacts.length} note${plan.impacts.length === 1 ? '' : 's'}.${warning ? ` ${warning}` : ''}`);
            setSelected(destination);
            setPlan(null);
        } catch (failure) { setError(message(failure)); setPlan(null); }
        finally { setBusy(false); }
    };

    return <section aria-label="Manage Assets" className="border-t border-outline p-4">
        <p className="text-xs text-secondary">Review affected notes before moving an image. Folder-wide moves and deletion are not available yet.</p>
        {backendMode === 'viewer' || backendMode === 'none' ? <p className="mt-3 text-sm text-secondary">Connect a writable workspace to manage assets.</p> : <>
            <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(170px,1fr)_minmax(220px,1.25fr)]">
                <div className="min-h-52 rounded border border-outline bg-surface">
                    <div className="flex flex-wrap items-center gap-1 border-b border-outline p-2 text-xs">
                        <button type="button" onClick={() => { setFolder(''); setSearch(''); }} className="font-semibold text-primary hover:text-accent">assets</button>
                        {folder.split('/').filter(Boolean).map((part, index, parts) => <React.Fragment key={index}>
                            <ChevronRight size={12} className="text-secondary" />
                            <button type="button" onClick={() => { setFolder(parts.slice(0, index + 1).join('/')); setSearch(''); }} className="text-primary hover:text-accent">{part}</button>
                        </React.Fragment>)}
                    </div>
                    <div className="flex items-center gap-2 border-b border-outline px-2 py-1 text-secondary"><Search size={14}/><input aria-label="Search managed assets" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search assets" className="min-w-0 flex-1 bg-transparent text-xs text-primary outline-none" /></div>
                    <div className="max-h-60 overflow-y-auto p-1 text-xs">
                        {!search && childFolders.map(path => <button type="button" key={path} onClick={() => setFolder(path)} className="flex w-full items-center gap-1 rounded p-1.5 text-left text-primary hover:bg-outline"><Folder size={14}/>{path.slice(prefix.length)}</button>)}
                        {visible.map(path => <button type="button" key={path} onClick={() => choose(path)} title={path} className={`block w-full truncate rounded p-1.5 text-left hover:bg-outline ${selected === path ? 'bg-accent/20 text-accent' : 'text-primary'}`}>{search ? path : path.slice(prefix.length)}</button>)}
                        {!visible.length && !childFolders.length && <p className="p-2 text-secondary">No assets here.</p>}
                    </div>
                </div>
                <div className="min-w-0 space-y-3">
                    {selected ? <>
                        <p className="break-all text-xs text-primary">Selected: assets/{selected}</p>
                        <div className="flex h-32 items-center justify-center overflow-hidden rounded border border-outline bg-surface">
                            {previewUrl ? <img src={previewUrl} alt="Selected asset preview" onLoad={event => setDimensions(`${event.currentTarget.naturalWidth} × ${event.currentTarget.naturalHeight}`)} className="max-h-full max-w-full object-contain" /> : <span className="text-xs text-secondary">No image preview</span>}
                        </div>
                        {(dimensions || fileSize) && <p className="text-xs text-secondary">{[dimensions, fileSize].filter(Boolean).join(' · ')}</p>}
                        <label htmlFor="managed-asset-destination" className="block text-xs font-medium text-primary">New path inside assets</label>
                        <input id="managed-asset-destination" value={destination} onChange={event => { setDestination(event.target.value); setPlan(null); setStatus(''); }} className="w-full rounded border border-outline bg-surface px-2 py-1.5 font-mono text-xs text-primary" />
                        {destinationError && <p className="text-xs text-red-300">{destinationError}</p>}
                        <button type="button" disabled={busy || !!destinationError || !destination} onClick={() => void review()} className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">{busy ? 'Working…' : 'Review rename / move'}</button>
                    </> : <p className="text-sm text-secondary">Select an asset to inspect it.</p>}
                </div>
            </div>
            {error && <p role="alert" className="mt-3 break-words text-xs text-red-300">{error}</p>}
            {status && <p role="status" className="mt-3 text-xs text-emerald-300">{status}</p>}
            {plan && <div className="mt-4 rounded border border-outline bg-surface p-3 text-xs text-primary" data-testid="asset-move-preview">
                <p className="break-all font-medium">{plan.source} → {plan.destination}</p>
                <p className="mt-1 text-secondary">{plan.impacts.length} affected note{plan.impacts.length === 1 ? '' : 's'} · {plan.impacts.reduce((sum, impact) => sum + impact.count, 0)} image reference{plan.impacts.reduce((sum, impact) => sum + impact.count, 0) === 1 ? '' : 's'}</p>
                {plan.conflicts.map(conflict => <p key={conflict} role="alert" className="mt-2 text-red-300">{conflict}</p>)}
                {plan.impacts.map(impact => <div key={impact.blockId} className="mt-3 border-t border-outline pt-2">
                    <p className="font-medium">{impact.title} <span className="text-secondary">({impact.fileName || impact.blockId})</span></p>
                    {impact.references.map((reference, index) => <p key={index} className="break-all font-mono text-[11px] text-secondary">{reference.before} → {reference.after}</p>)}
                </div>)}
                <button type="button" disabled={busy || !!plan.conflicts.length} onClick={() => void commit()} className="mt-4 rounded bg-accent px-3 py-1.5 font-medium text-white disabled:opacity-50">Confirm move</button>
            </div>}
        </>}
    </section>;
}
