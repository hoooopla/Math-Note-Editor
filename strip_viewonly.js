import fs from 'fs/promises';
import path from 'path';

const blocksDir = path.join(process.cwd(), 'blocks');

async function clean() {
    try {
        const files = await fs.readdir(blocksDir);
        let cleaned = 0;
        for (const file of files) {
            if (!file.endsWith('.md')) continue;
            const filePath = path.join(blocksDir, file);
            let content = await fs.readFile(filePath, 'utf-8');
            if (content.includes('isViewOnly:')) {
                // Strip the isViewOnly line from frontmatter
                content = content.replace(/^isViewOnly:.*\r?\n/m, '');
                await fs.writeFile(filePath, content);
                cleaned++;
            }
        }
        console.log(`Cleaned ${cleaned} files.`);
    } catch(e) {
        console.error(e);
    }
}
clean();
