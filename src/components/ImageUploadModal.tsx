import React, { useState, useEffect } from 'react';
import { useStore } from '../store';
import { X, Upload, FileImage, Folder, AlertTriangle } from 'lucide-react';

export function ImageUploadModal() {
    const { imageUploadParams, setImageUploadParams, saveAsset, listAssets } = useStore();
    const [path, setPath] = useState('');
    const [width, setWidth] = useState('500');
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [isSaving, setIsSaving] = useState(false);
    const [existingAssets, setExistingAssets] = useState<string[]>([]);
    
    useEffect(() => {
        if (imageUploadParams?.file) {
            listAssets().then(assets => setExistingAssets(assets));
            const url = URL.createObjectURL(imageUploadParams.file);
            setPreviewUrl(url);
            let defaultName = imageUploadParams.file.name;
            if (!defaultName || defaultName === 'image.png') {
                const timestamp = new Date().getTime();
                defaultName = `image_${timestamp}.png`;
            }
            setPath(defaultName);
            return () => URL.revokeObjectURL(url);
        } else {
            setPreviewUrl(null);
            setPath('');
        }
    }, [imageUploadParams, listAssets]);

    if (!imageUploadParams) return null;

    const finalPath = path.trim() || 'image.png';
    const willOverwrite = existingAssets.includes('assets/' + finalPath) || existingAssets.includes(finalPath);

    const handleSave = async () => {
        setIsSaving(true);
        try {
            const savedUrl = await saveAsset(imageUploadParams.file, finalPath);
            const wAttr = width.trim() ? ` width="${width.trim()}"` : '';
            const htmlTag = `<img src="${savedUrl}"${wAttr} />`;
            imageUploadParams.onInsert(htmlTag);
            setImageUploadParams(null);
        } catch (e) {
            console.error("Save asset failed", e);
            alert("Failed to save asset");
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[100] p-4">
            <div className="bg-surface rounded-xl shadow-xl w-full max-w-2xl flex border border-outline overflow-hidden max-h-[80vh]">
                <div className="w-1/3 border-r border-outline bg-base/50 flex flex-col overflow-hidden">
                    <div className="p-3 border-b border-outline flex items-center gap-2 text-primary font-bold bg-surface">
                        <Folder size={16} className="text-secondary" />
                        <span>assets/</span>
                    </div>
                    <div className="flex-1 overflow-y-auto p-2 space-y-1">
                        {existingAssets.map(asset => {
                            const name = asset.replace(/^assets\//, '');
                            return (
                                <button 
                                    key={asset} 
                                    onClick={() => setPath(name)}
                                    className={`w-full text-left px-2 py-1.5 rounded text-sm flex items-center gap-2 transition-colors overflow-hidden ${path === name ? 'bg-accent/20 text-accent font-medium' : 'text-secondary hover:bg-outline hover:text-primary'}`}
                                >
                                    <FileImage size={14} className="flex-shrink-0" />
                                    <span className="truncate">{name}</span>
                                </button>
                            );
                        })}
                        {existingAssets.length === 0 && (
                            <div className="text-xs text-secondary/50 text-center py-4">No recent assets</div>
                        )}
                    </div>
                </div>
                
                <div className="flex-1 flex flex-col">
                    <div className="flex justify-between items-center p-4 border-b border-outline">
                        <h2 className="text-lg font-bold text-primary">Upload Image</h2>
                        <button onClick={() => setImageUploadParams(null)} className="p-1 text-secondary hover:text-primary transition-colors">
                            <X size={20} />
                        </button>
                    </div>
                    
                    <div className="p-4 space-y-4 overflow-y-auto flex-1">
                        {previewUrl && (
                            <div className="flex justify-center bg-base tracking-pattern rounded-lg border border-outline overflow-hidden p-2">
                                <img src={previewUrl} alt="Preview" className="max-h-48 object-contain rounded drop-shadow-md" />
                            </div>
                        )}
                        
                        <div className="space-y-1">
                            <label className="text-sm font-medium text-primary">Filename / Path</label>
                            <div className="flex text-sm">
                                <span className="bg-outline/50 border border-outline border-r-0 px-3 py-2 rounded-l-lg text-secondary flex items-center font-mono text-xs">assets/</span>
                                <input
                                    autoFocus
                                    type="text"
                                    value={path}
                                    onChange={(e) => setPath(e.target.value.replace(/[^a-zA-Z0-9.\-_/]/g, ''))}
                                    onFocus={(e) => e.target.select()}
                                    onKeyDown={(e) => e.key === 'Enter' && handleSave()}
                                    placeholder="folder/image.png"
                                    className={`flex-1 bg-base border rounded-r-lg px-3 py-2 text-sm text-primary focus:outline-none ${willOverwrite ? 'border-orange-500/50 bg-orange-500/5 focus:border-orange-500' : 'border-outline focus:border-accent'}`}
                                />
                            </div>
                            {willOverwrite && (
                                <div className="text-xs text-orange-500 font-medium flex items-center gap-1 mt-1">
                                    <AlertTriangle size={12} />
                                    File already exists and will be overwritten
                                </div>
                            )}
                        </div>

                        <div className="space-y-1">
                            <label className="text-sm font-medium text-primary">Width (HTML attribute)</label>
                            <input
                                type="text"
                                value={width}
                                onChange={(e) => setWidth(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && handleSave()}
                                placeholder='500 or "100%" ...'
                                className="w-full bg-base border border-outline rounded-lg px-3 py-2 text-sm text-primary focus:outline-none focus:border-accent"
                            />
                        </div>
                    </div>

                    <div className="p-4 border-t border-outline flex justify-end gap-3 bg-base/50">
                        <button
                            onClick={() => setImageUploadParams(null)}
                            className="px-5 py-2 text-sm text-primary hover:bg-outline rounded-lg transition-colors font-medium"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleSave}
                            disabled={isSaving}
                            className={`px-5 py-2 text-sm text-white font-medium flex items-center gap-2 rounded-lg transition-colors shadow-sm disabled:opacity-50 ${willOverwrite ? 'bg-orange-600 hover:bg-orange-700' : 'bg-accent hover:bg-accent/90'}`}
                        >
                            {isSaving ? <span className="animate-spin truncate max-w-[1.2rem]">⟳</span> : <Upload size={16} />}
                            {isSaving ? 'Saving...' : (willOverwrite ? 'Overwrite & Insert' : 'Insert')}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
