import re

with open('src/store/index.ts', 'r') as f:
    content = f.read()

content = content.replace(
    'backendMode: "server" | "local" | "none";',
    'backendMode: "server" | "local" | "viewer" | "none";\n  loadViewerFiles: (files: FileList) => Promise<void>;'
)

# Also import parseFrontmatter
content = content.replace(
    'import { api as backendApi } from "./api";',
    'import { api as backendApi, parseFrontmatter } from "./api";'
)

with open('src/store/index.ts', 'w') as f:
    f.write(content)
