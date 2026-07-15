const parseFrontmatter = (text) => {
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)/);
    if (!match) return { data: {}, content: text };
    
    const data = {};
    match[1].split('\n').forEach(line => {
        const idx = line.indexOf(':');
        if (idx > -1) {
            const key = line.substring(0, idx).trim();
            const val = line.substring(idx + 1).trim();
            data[key] = val;
        }
    });
    return { data, content: match[2] };
};

const stringifyFrontmatter = (data, content) => {
    let fm = '---\n';
    for (const [k, v] of Object.entries(data)) {
        fm += `${k}: ${v}\n`;
    }
    fm += '---\n';
    return fm + content;
};

const out = stringifyFrontmatter({ id: "123", title: "foo|bar", label: "baz|qux" }, "hello");
console.log(out);
console.log(parseFrontmatter(out));
