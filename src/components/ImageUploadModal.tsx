import React, { useState, useEffect } from 'react';
import { useStore } from '../store';
import { X, Upload } from 'lucide-react';

export function ImageUploadModal() {
    const { imageUploadParams, setImageUploadParams, saveAsset } = useStore();
    const [path, setPath] = useState('');
    const [width, setWidth] = useState('500');
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [isSaving, setIsSaving] = useState(false);

    useEffect(() => {
        if (imageUploadParams?.file) {
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
    }, [imageUploadParams]);

    if (!imageUploadParams) return null;

    const handleSave = async () => {
        setIsSaving(true);
        try {
            const finalPath = path.trim() || 'image.png';
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
            <div className="bg-surface rounded-xl shadow-xl w-full max-w-md flex flex-col border border-outline overflow-hidden">
                <div className="flex justify-between items-center p-4 border-b border-outline">
                    <h2 className="text-lg font-bold text-primary">Upload Image</h2>
                    <button onClick={() => setImageUploadParams(null)} className="p-1 text-secondary hover:text-primary transition-colors">
                        <X size={20} />
                    </button>
                </div>
                
                <div className="p-4 space-y-4">
                    {previewUrl && (
                        <div className="flex justify-center bg-base rounded-lg border border-outline overflow-hidden">
                            <img src={previewUrl} alt="Preview" className="max-h-48 object-contain" />
                        </div>
                    )}
                    
                    <div className="space-y-1">
                        <label className="text-sm font-medium text-primary">Filename / Path (inside assets/)</label>
                        <input
                            autoFocus
                            type="text"
                            value={path}
                            onChange={(e) => setPath(e.target.value)}
                            onFocus={(e) => e.target.select()}
                            onKeyDown={(e) => e.key === 'Enter' && handleSave()}
                            placeholder="folder/image.png"
                            className="w-full bg-base border border-outline rounded-lg px-3 py-2 text-sm text-primary focus:outline-none focus:border-accent"
                        />
                    </div>

                    <div className="space-y-1">
                        <label className="text-sm font-medium text-primary">Width</label>
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
                        className="px-5 py-2 text-sm bg-accent text-white font-medium flex items-center gap-2 hover:bg-accent/90 rounded-lg transition-colors shadow-sm disabled:opacity-50"
                    >
                        {isSaving ? <span className="animate-spin truncate max-w-[1.2rem]">⟳</span> : <Upload size={16} />}
                        {isSaving ? 'Saving...' : 'Insert'}
                    </button>
                </div>
            </div>
        </div>
    );
}
