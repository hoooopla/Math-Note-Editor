import re

with open('src/store/api.ts', 'r') as f:
    content = f.read()

content = content.replace(
    'mode: "server" | "local" | "none";',
    'mode: "server" | "local" | "none" | "viewer";'
)

with open('src/store/api.ts', 'w') as f:
    f.write(content)
