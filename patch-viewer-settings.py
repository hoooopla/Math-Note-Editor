import re

with open('src/store/index.ts', 'r') as f:
    content = f.read()

impl = """
  loadViewerFiles: async (files: FileList) => {
    const newBlocks: BlockData[] = [];
    let loadedSettings: any = null;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.name.endsWith('.md')) {
        const text = await file.text();
        const { data, content } = parseFrontmatter(text);
        const id = data.id || file.name.replace('.md', '');
        newBlocks.push({
          id,
          title: data.title || '',
          label: data.label || '',
          content,
          hasContent: content.trim().length > 0
        });
      } else if (file.name === 'settings.json' && file.webkitRelativePath.includes('/setting/')) {
        try {
          loadedSettings = JSON.parse(await file.text());
        } catch (e) {}
      }
    }
    
    set({ blocks: newBlocks, backendMode: 'viewer', isLoaded: true });
    
    if (loadedSettings) {
      set(state => ({ settings: { ...state.settings, ...loadedSettings } }));
    }
    
    // Auto-open first tab if any
    if (newBlocks.length > 0) {
      set({ openTabs: [newBlocks[0].id], activeTab: newBlocks[0].id });
    }
  },
"""

# Replace the existing loadViewerFiles implementation
content = re.sub(
    r'loadViewerFiles: async \(files: FileList\) => \{.*?\},',
    impl.strip() + ',',
    content,
    flags=re.DOTALL
)

with open('src/store/index.ts', 'w') as f:
    f.write(content)
