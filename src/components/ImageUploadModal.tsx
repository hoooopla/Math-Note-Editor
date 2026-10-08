import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronRight, File, FileImage, Folder, FolderPlus, Search, Upload, X } from 'lucide-react';
import { useStore } from '../store';
import { encodedAssetReference, imageReference, validateAssetPath, validateImageWidth } from '../lib/asset-reference';
import { imageUploadLimit, validateImageFilename, validateImageUpload } from '../lib/image-upload-policy';
import { ImageGeometry, readImageGeometry, validImageGeometry } from '../lib/image-geometry';

function relativeAssetPath(path: string): string {
    return path.replace(/^assets\//, '');
}

function isImageAsset(path: string): boolean {
    return /\.(?:png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(path);
}

export function ImageUploadModal() {
    const params = useStore(state => state.imageUploadParams);
    const close = useStore(state => state.setImageUploadParams);
    const saveAsset = useStore(state => state.saveAsset);
    const listAssets = useStore(state => state.listAssets);
    const getAssetUrl = useStore(state => state.getAssetUrl);
    const backendMode = useStore(state => state.backendMode);
    const [mode, setMode] = useState<'save' | 'existing'>('save');
    const [uploadFile, setUploadFile] = useState<File | null>(null);
    const [folder, setFolder] = useState('');
    const [fileName, setFileName] = useState('');
    const [newFolderName, setNewFolderName] = useState<string | null>(null);
    const [draftFolders, setDraftFolders] = useState<string[]>([]);
    const [assets, setAssets] = useState<string[]>([]);
    const [listingState, setListingState] = useState<'loading' | 'ready' | 'error'>('loading');
    const [search, setSearch] = useState('');
    const [selectedExisting, setSelectedExisting] = useState('');
    const [width, setWidth] = useState('500');
    const [alt, setAlt] = useState('');
    const [uploadPreview, setUploadPreview] = useState('');
    const [uploadGeometry, setUploadGeometry] = useState<ImageGeometry | null>(null);
    const [existingPreview, setExistingPreview] = useState('');
    const [existingGeometry, setExistingGeometry] = useState<ImageGeometry | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        if (!params) return;
        let active = true;
        setUploadFile(params.file);
        setUploadGeometry(null);
        setUploadPreview('');
        setMode(params.file ? 'save' : 'existing');
        setFolder('');
        setFileName(params.file ? (params.file.name && params.file.name !== 'image.png'
            ? params.file.name : `image_${Date.now()}.png`) : '');
        setNewFolderName(null);
        setDraftFolders([]);
        setSelectedExisting('');
        setExistingGeometry(null);
        setSearch('');
        setWidth('500');
        setAlt('');
        setError('');
        setListingState('loading');
        listAssets().then(paths => {
            if (active) {
                setAssets(paths.map(relativeAssetPath).sort((a, b) => a.localeCompare(b)));
                setListingState('ready');
            }
        }).catch(() => {
            if (active) setListingState('error');
        });
        return () => { active = false; };
    }, [params, listAssets]);

    useEffect(() => {
        if (!uploadFile || !params) {
            setUploadPreview('');
            return;
        }
        const preview = URL.createObjectURL(uploadFile);
        setUploadPreview(preview);
        return () => URL.revokeObjectURL(preview);
    }, [uploadFile, params]);

    useEffect(() => {
        if (!selectedExisting || !params) {
            setExistingPreview('');
            setExistingGeometry(null);
            return;
        }
        let active = true;
        let objectUrl = '';
        setExistingGeometry(null);
        getAssetUrl(`assets/${selectedExisting}`).then(url => {
            if (!active) {
                if (url.startsWith('blob:')) URL.revokeObjectURL(url);
                return;
            }
            objectUrl = url.startsWith('blob:') ? url : '';
            setExistingPreview(url);
        }).catch(() => {
            if (active) setExistingPreview('');
        });
        return () => {
            active = false;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [selectedExisting, params, getAssetUrl]);

    const allFolders = useMemo(() => {
        const paths = new Set(draftFolders);
        for (const asset of assets) {
            const parts = asset.split('/');
            for (let i = 1; i < parts.length; i++) paths.add(parts.slice(0, i).join('/'));
        }
        return [...paths];
    }, [assets, draftFolders]);
    const childFolders = allFolders.filter(path =>
        path.startsWith(folder ? `${folder}/` : '') &&
        path !== folder &&
        !path.slice(folder ? folder.length + 1 : 0).includes('/')
    ).sort((a, b) => a.localeCompare(b));
    const childFiles = assets.filter(path =>
        path.startsWith(folder ? `${folder}/` : '') &&
        !path.slice(folder ? folder.length + 1 : 0).includes('/')
    );
    const searching = search.trim().length > 0;
    const searchResults = searching ? assets.filter(path => path.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) : [];
    const visibleFiles = searching ? searchResults : childFiles;
    const destination = folder ? `${folder}/${fileName}` : fileName;
    const pathError = fileName.includes('/') ? 'File name cannot contain a slash. Use New folder to choose a folder.'
        : validateAssetPath(destination) || (uploadFile ? validateImageFilename(destination, uploadFile.type) : null);
    const widthError = validateImageWidth(width.trim());
    const fileError = uploadFile ? validateImageUpload(uploadFile, backendMode) : null;
    const collision = assets.includes(destination);
    const chosenPath = mode === 'save' ? destination : selectedExisting;
    const canSubmit = !busy && listingState === 'ready' && !widthError && (mode === 'save' ? !!uploadFile && !fileError && !pathError : !!selectedExisting);
    const breadcrumbs = folder ? folder.split('/') : [];

    if (!params) return null;

    const navigate = (path: string) => {
        setFolder(path);
        setSearch('');
        setNewFolderName(null);
        setSelectedExisting('');
        setExistingPreview('');
        setExistingGeometry(null);
        setError('');
    };
    const addFolder = () => {
        const name = newFolderName ?? '';
        const path = folder ? `${folder}/${name}` : name;
        const problem = validateAssetPath(path);
        if (problem || name.includes('/')) {
            setError(problem || 'Enter a single folder name.');
            return;
        }
        if (allFolders.includes(path) || assets.includes(path)) {
            setError('A folder or file with that name already exists.');
            return;
        }
        // The backend creates this directory together with the saved image.
        setDraftFolders(current => [...current, path]);
        navigate(path);
    };
    const retryListing = async () => {
        setListingState('loading');
        try {
            setAssets((await listAssets()).map(relativeAssetPath).sort((a, b) => a.localeCompare(b)));
            setListingState('ready');
        } catch {
            setListingState('error');
        }
    };
    const submit = async () => {
        if (!canSubmit) return;
        setBusy(true);
        setError('');
        let savedPath = '';
        try {
            params.assertInsertable();
            if (mode === 'save') {
                if (!uploadFile) throw new Error('Choose an image first.');
                const geometry = uploadGeometry || await readImageGeometry(uploadFile);
                savedPath = await saveAsset(uploadFile, destination, collision);
                params.onInsert(imageReference(destination, width.trim(), alt.trim(), geometry));
            } else {
                const geometry = existingGeometry || (existingPreview ? await readImageGeometry(existingPreview) : null);
                params.onInsert(imageReference(selectedExisting, width.trim(), alt.trim(), geometry));
            }
            close(null);
        } catch (cause) {
            const detail = cause instanceof Error ? cause.message : 'Could not save the image.';
            setError(savedPath ? `The image was saved as ${savedPath}, but was not inserted. Close this picker, reopen it in the intended note, and choose Insert existing. ${detail}` : detail);
            void retryListing();
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4" role="presentation">
            <div role="dialog" aria-modal="true" aria-label="Insert image" className="flex max-h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-outline bg-surface shadow-xl">
                <header className="flex items-center justify-between border-b border-outline p-4">
                    <h2 className="text-lg font-bold text-primary">Insert image</h2>
                    <button type="button" aria-label="Close" onClick={() => close(null)} className="text-secondary hover:text-primary"><X size={20} /></button>
                </header>
                <div className="flex gap-2 border-b border-outline px-4 pt-3">
                    <button type="button" onClick={() => setMode('save')} className={`rounded-t px-3 py-2 text-sm ${mode === 'save' ? 'bg-accent/20 text-accent' : 'text-secondary hover:text-primary'}`}>Save a copy</button>
                    <button type="button" onClick={() => setMode('existing')} className={`rounded-t px-3 py-2 text-sm ${mode === 'existing' ? 'bg-accent/20 text-accent' : 'text-secondary hover:text-primary'}`}>Insert existing</button>
                </div>
                <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(220px,1fr)_minmax(300px,1.2fr)]">
                    <section aria-label="Assets browser" className="flex min-h-[220px] flex-col overflow-hidden border-b border-outline bg-base/40 md:border-b-0 md:border-r">
                        <div className="flex flex-wrap items-center gap-1 border-b border-outline px-3 py-2 text-sm">
                            <button type="button" onClick={() => navigate('')} className="font-semibold text-primary hover:text-accent">assets</button>
                            {breadcrumbs.map((part, index) => (
                                <React.Fragment key={index}>
                                    <ChevronRight size={14} className="text-secondary" />
                                    <button type="button" onClick={() => navigate(breadcrumbs.slice(0, index + 1).join('/'))} className="text-primary hover:text-accent">{part}</button>
                                </React.Fragment>
                            ))}
                        </div>
                        <div className="flex items-center gap-2 border-b border-outline px-3 py-2 text-secondary">
                            <Search size={15} />
                            <input aria-label="Search assets" value={search} onChange={event => setSearch(event.target.value)} placeholder="Find an image or path" className="min-w-0 flex-1 bg-transparent text-sm text-primary outline-none placeholder:text-secondary" />
                        </div>
                        <div className="flex-1 space-y-1 overflow-y-auto p-2">
                            {listingState === 'loading' && <p className="px-2 py-4 text-center text-sm text-secondary">Loading assets…</p>}
                            {listingState === 'error' && <div role="alert" className="px-2 py-4 text-center text-sm text-red-300">
                                Could not list assets. Saving is paused to protect existing files.
                                <button type="button" onClick={() => { void retryListing(); }} className="ml-2 font-semibold underline">Retry</button>
                            </div>}
                            {!searching && childFolders.map(path => (
                                <button type="button" key={path} onClick={() => navigate(path)} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-primary hover:bg-outline">
                                    <Folder size={16} className="shrink-0 text-secondary" /><span className="min-w-0 truncate" title={path}>{path.split('/').at(-1)}</span>
                                </button>
                            ))}
                            {visibleFiles.map(path => (
                                <button type="button" key={path} disabled={mode === 'existing' && !isImageAsset(path)} onClick={() => { setError(''); if (mode === 'save') { const parts = path.split('/'); setFolder(parts.slice(0, -1).join('/')); setFileName(parts.at(-1) || ''); setSearch(''); } else { setSelectedExisting(path); setExistingPreview(''); setExistingGeometry(null); } }} className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-outline disabled:cursor-not-allowed disabled:opacity-40 ${selectedExisting === path ? 'bg-accent/20 text-accent' : 'text-primary'}`}>
                                    {isImageAsset(path) ? <FileImage size={16} className="shrink-0 text-secondary" /> : <File size={16} className="shrink-0 text-secondary" />}
                                    <span className="min-w-0 truncate" title={path}>{searching ? path : path.split('/').at(-1)}</span>
                                </button>
                            ))}
                            {listingState === 'ready' && !(searching ? searchResults.length : childFolders.length + childFiles.length) && <p className="px-2 py-4 text-center text-sm text-secondary">{searching ? 'No matching assets' : 'No assets here yet'}</p>}
                        </div>
                        {mode === 'save' && <div className="border-t border-outline p-2">
                            {newFolderName === null ? (
                                <button type="button" onClick={() => setNewFolderName('')} className="flex items-center gap-2 rounded px-2 py-1 text-sm text-secondary hover:text-primary"><FolderPlus size={16} /> New folder</button>
                            ) : (
                                <div className="flex gap-2">
                                    <input autoFocus aria-label="New folder name" value={newFolderName} onChange={event => setNewFolderName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') addFolder(); if (event.key === 'Escape') setNewFolderName(null); }} className="min-w-0 flex-1 rounded border border-outline bg-base px-2 py-1 text-sm text-primary" />
                                    <button type="button" onClick={addFolder} className="text-sm text-accent">Add</button>
                                    <button type="button" aria-label="Cancel new folder" onClick={() => setNewFolderName(null)} className="text-secondary"><X size={16} /></button>
                                </div>
                            )}
                        </div>}
                    </section>
                    <section className="space-y-4 overflow-y-auto p-4">
                        {error && <p role="alert" className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>}
                        <div className="flex h-44 items-center justify-center overflow-hidden rounded-lg border border-outline bg-base p-2">
                            {(mode === 'save' ? uploadPreview : existingPreview)
                                ? <img key={mode === 'save' ? uploadPreview : existingPreview}
                                    src={mode === 'save' ? uploadPreview : existingPreview} alt="Image preview"
                                    onLoad={event => {
                                        const image = event.currentTarget;
                                        const measured = validImageGeometry(image.naturalWidth, image.naturalHeight);
                                        if (mode === 'existing') setExistingGeometry(measured);
                                        else setUploadGeometry(measured);
                                    }} className="max-h-full max-w-full object-contain" />
                                : <span className="text-sm text-secondary">Select an image to preview</span>}
                        </div>
                        {mode === 'save' ? (
                            <div className="space-y-3">
                                {draftFolders.includes(folder) && <p className="text-xs text-secondary">This folder will be created when you save the image.</p>}
                                <div>
                                    <label htmlFor="asset-upload" className="block text-sm font-medium text-primary">Image to save</label>
                                    <input id="asset-upload" type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/avif,image/bmp" onChange={event => { const file = event.target.files?.[0] || null; setUploadFile(file); setUploadGeometry(null); setUploadPreview(''); if (file) setFileName(file.name); }} className="mt-1 block w-full text-sm text-secondary file:mr-3 file:rounded file:border-0 file:bg-accent/20 file:px-3 file:py-1.5 file:text-accent" />
                                    {uploadFile && <p className="mt-1 break-all text-xs text-secondary">Selected: {uploadFile.name}</p>}
                                    <p className="mt-1 text-xs text-secondary">PNG, JPEG, GIF, WebP, AVIF, or BMP; up to {Math.round(imageUploadLimit(backendMode) / (1024 * 1024))} MB.</p>
                                    {fileError && <p className="mt-1 text-xs text-red-300">{fileError}</p>}
                                </div>
                                <div>
                                <label htmlFor="asset-filename" className="block text-sm font-medium text-primary">File name</label>
                                <input id="asset-filename" value={fileName} onChange={event => setFileName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') submit(); }} className="mt-1 w-full rounded border border-outline bg-base px-3 py-2 text-sm text-primary focus:border-accent focus:outline-none" />
                                {pathError && <p className="mt-1 text-xs text-red-300">{pathError}</p>}
                                {collision && !pathError && <p className="mt-1 flex items-center gap-1 text-xs text-orange-400"><AlertTriangle size={13} /> This file exists. Saving will replace it.</p>}
                                </div>
                            </div>
                        ) : <p className="text-sm text-secondary">{selectedExisting ? `Selected: assets/${selectedExisting}` : 'Choose an image from the assets browser.'}</p>}
                        {chosenPath && (mode === 'existing' || !pathError) && <p className="break-all text-xs text-secondary">Reference: {encodedAssetReference(chosenPath)}</p>}
                        <div>
                            <label htmlFor="asset-width" className="block text-sm font-medium text-primary">Width (optional)</label>
                            <input id="asset-width" value={width} onChange={event => setWidth(event.target.value)} placeholder="500 or 100%" className="mt-1 w-full rounded border border-outline bg-base px-3 py-2 text-sm text-primary focus:border-accent focus:outline-none" />
                            {widthError && <p className="mt-1 text-xs text-red-300">{widthError}</p>}
                        </div>
                        <div>
                            <label htmlFor="asset-alt" className="block text-sm font-medium text-primary">Description (optional)</label>
                            <input id="asset-alt" value={alt} onChange={event => setAlt(event.target.value)} className="mt-1 w-full rounded border border-outline bg-base px-3 py-2 text-sm text-primary focus:border-accent focus:outline-none" />
                        </div>
                    </section>
                </div>
                <footer className="flex justify-end gap-3 border-t border-outline bg-base/50 p-4">
                    <button type="button" onClick={() => close(null)} className="rounded px-4 py-2 text-sm text-primary hover:bg-outline">Cancel</button>
                    <button type="button" disabled={!canSubmit} onClick={submit} className="flex items-center gap-2 rounded bg-accent px-4 py-2 text-sm text-white disabled:opacity-50">
                        <Upload size={16} /> {busy ? 'Working…' : mode === 'existing' ? 'Insert image' : collision ? 'Replace & insert' : 'Save & insert'}
                    </button>
                </footer>
            </div>
        </div>
    );
}
