import re

with open('src/components/Block.tsx', 'r') as f:
    content = f.read()

content = content.replace(
    '{isFocused && (',
    '{isFocused && backendMode !== "viewer" && ('
)

with open('src/components/Block.tsx', 'w') as f:
    f.write(content)
