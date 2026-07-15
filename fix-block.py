import re

with open('src/components/Block.tsx', 'r') as f:
    content = f.read()

content = content.replace(
    'export function Block({ block, blocks, isFocused, focusDirection, macros, setActive, onUp, onDown, updateBlock, deleteBlock }: BlockProps) {',
    'export function Block({ block, blocks, isFocused, focusDirection, macros, setActive, onUp, onDown, updateBlock, deleteBlock }: BlockProps) {\n    const backendMode = useStore(state => state.backendMode);'
)

with open('src/components/Block.tsx', 'w') as f:
    f.write(content)
