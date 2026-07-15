import re

with open('src/store/index.ts', 'r') as f:
    content = f.read()

impl = """
  loadViewerFiles: async (files: FileList) => {
    const newBlocks: import('./api').BlockData[] = [];
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
      }
    }
    
    // Sort blocks by title or somehow? Or let's just keep as is
    set({ blocks: newBlocks, backendMode: 'viewer', isLoaded: true });
    
    // Auto-open first tab if any
    if (newBlocks.length > 0) {
      set({ openTabs: [newBlocks[0].id], activeTab: newBlocks[0].id });
    }
  },
"""

content = content.replace(
    '  connectLocalFS: async () => {',
    impl + '\n  connectLocalFS: async () => {'
)

with open('src/store/index.ts', 'w') as f:
    f.write(content)
