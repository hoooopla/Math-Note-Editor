import re

with open('src/App.tsx', 'r') as f:
    content = f.read()

# Add useRef for file input
if 'const fileInputRef = useRef<HTMLInputElement>(null);' not in content:
    content = content.replace(
        'export default function App() {',
        'export default function App() {\n    const fileInputRef = React.useRef<HTMLInputElement>(null);\n    const loadViewerFiles = useStore(state => state.loadViewerFiles);'
    )
    
if 'import React' not in content:
    content = content.replace(
        'import { useEffect',
        'import React, { useEffect'
    )

viewer_input = """
                    {backendMode === "none" && (
                        <div className="flex items-center gap-2">
                            <button 
                                onClick={() => connectLocalFS()}
                                className="px-3 py-1.5 bg-accent/20 text-accent rounded-lg font-medium text-sm hover:bg-accent/30 transition-colors flex items-center gap-2 mr-2"
                            >
                                <FolderOpen size={16} /> Open Workspace
                            </button>
                            <input 
                                type="file" 
                                ref={fileInputRef} 
                                style={{display: 'none'}} 
                                webkitdirectory="" 
                                onChange={(e) => {
                                    if (e.target.files && e.target.files.length > 0) {
                                        loadViewerFiles(e.target.files);
                                    }
                                }}
                            />
                            <button 
                                onClick={() => fileInputRef.current?.click()}
                                className="px-3 py-1.5 border border-outline hover:bg-outline rounded-lg font-medium text-sm transition-colors flex items-center gap-2 mr-2"
                                title="Read-only viewer (Works on iPad)"
                            >
                                <FileText size={16} /> Read-Only Viewer
                            </button>
                        </div>
                    )}
"""

content = content.replace(
    '''                    {backendMode === "none" && (
                        <button 
                            onClick={() => connectLocalFS()}
                            className="px-3 py-1.5 bg-accent/20 text-accent rounded-lg font-medium text-sm hover:bg-accent/30 transition-colors flex items-center gap-2 mr-2"
                        >
                            <FolderOpen size={16} /> Open Workspace
                        </button>
                    )}''',
    viewer_input.strip()
)

viewer_empty_state = """
                                {backendMode === "none" ? (
                                    <>
                                        <FolderOpen size={48} className="mb-4 opacity-50 text-accent" />
                                        <p className="mb-4">Connect a workspace folder to begin.</p>
                                        <div className="flex flex-col gap-3">
                                            <button 
                                                onClick={() => connectLocalFS()}
                                                className="px-4 py-2 bg-accent/20 hover:bg-accent/30 text-accent rounded-lg transition-colors flex items-center gap-2 justify-center"
                                            >
                                                <FolderOpen size={16} /> Open Workspace
                                            </button>
                                            <button 
                                                onClick={() => fileInputRef.current?.click()}
                                                className="px-4 py-2 border border-outline hover:bg-outline rounded-lg transition-colors flex items-center gap-2 justify-center"
                                                title="Read-only viewer (Works on iPad)"
                                            >
                                                <FileText size={16} /> View Folder (Read-Only)
                                            </button>
                                        </div>
                                    </>
"""

content = content.replace(
    '''                                {backendMode === "none" ? (
                                    <>
                                        <FolderOpen size={48} className="mb-4 opacity-50 text-accent" />
                                        <p>Connect a workspace folder to begin.</p>
                                    </>''',
    viewer_empty_state.strip()
)

with open('src/App.tsx', 'w') as f:
    f.write(content)
