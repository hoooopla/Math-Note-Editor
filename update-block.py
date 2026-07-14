import re

with open('src/components/Block.tsx', 'r') as f:
    content = f.read()

content = content.replace(
    "replace(/[\[\]\|]/g, '')",
    "replace(/[\[\]]/g, '').replace(/\\|\\|/g, '|')"
)

with open('src/components/Block.tsx', 'w') as f:
    f.write(content)
