import re

with open('src/App.tsx', 'r') as f:
    content = f.read()

content = content.replace(
    '''                    <button 
                        onClick={async () => {
                            const newBlock = await addBlock();
                            if (newBlock) {
                                setOpenTabs([...openTabs, newBlock.id]);
                                setActiveTab(newBlock.id);
                            }
                        }}
                        className="p-1.5 hover:bg-accent/20 rounded text-accent transition-colors"
                        title="New Block"
                    >
                        <Plus size={18} />
                    </button>''',
    '''                    {backendMode !== "viewer" && (
                        <button 
                            onClick={async () => {
                                const newBlock = await addBlock();
                                if (newBlock) {
                                    setOpenTabs([...openTabs, newBlock.id]);
                                    setActiveTab(newBlock.id);
                                }
                            }}
                            className="p-1.5 hover:bg-accent/20 rounded text-accent transition-colors"
                            title="New Block"
                        >
                            <Plus size={18} />
                        </button>
                    )}'''
)

with open('src/App.tsx', 'w') as f:
    f.write(content)
