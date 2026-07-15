import re

with open('src/components/Block.tsx', 'r') as f:
    content = f.read()

content = content.replace(
    'onDoubleClick={(e) => {\n                    e.stopPropagation();\n                    setTitleInput(block.title);',
    'onDoubleClick={(e) => {\n                    e.stopPropagation();\n                    if (backendMode === "viewer") return;\n                    setTitleInput(block.title);'
)

with open('src/components/Block.tsx', 'w') as f:
    f.write(content)
