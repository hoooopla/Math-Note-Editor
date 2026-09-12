import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { atomicWriteFile, backupFile } from "../src/lib/atomic-file";

async function withTemporaryDirectory(run: (directory: string) => Promise<void>) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "math-note-atomic-save-"));
    try {
        await run(directory);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
}

test("atomically replaces a file and keeps its previous contents as a backup", async () => {
    await withTemporaryDirectory(async directory => {
        const filePath = path.join(directory, "note.md");
        const backupPath = path.join(directory, ".math-note-backups", "note.md.bak");
        await atomicWriteFile(filePath, "first version", { backupPath });
        await assert.rejects(fs.access(backupPath));

        await atomicWriteFile(filePath, "second version", { backupPath });

        assert.equal(await fs.readFile(filePath, "utf-8"), "second version");
        assert.equal(await fs.readFile(backupPath, "utf-8"), "first version");
        assert.deepEqual((await fs.readdir(directory)).sort(), [".math-note-backups", "note.md"]);
    });
});

test("serializes overlapping saves so the backup is the immediately previous version", async () => {
    await withTemporaryDirectory(async directory => {
        const filePath = path.join(directory, "setting", "settings.json");
        const backupPath = path.join(directory, ".math-note-backups", "setting", "settings.json.bak");
        await atomicWriteFile(filePath, "one", { backupPath });
        await Promise.all([
            atomicWriteFile(filePath, "two", { backupPath }),
            atomicWriteFile(filePath, "three", { backupPath })
        ]);

        assert.equal(await fs.readFile(filePath, "utf-8"), "three");
        assert.equal(await fs.readFile(backupPath, "utf-8"), "two");
    });
});

test("can refresh a backup without changing the source", async () => {
    await withTemporaryDirectory(async directory => {
        const filePath = path.join(directory, "deleted-note.md");
        const backupPath = path.join(directory, ".math-note-backups", "deleted-note.md.bak");
        await atomicWriteFile(filePath, "recover me");
        await backupFile(filePath, backupPath);

        assert.equal(await fs.readFile(filePath, "utf-8"), "recover me");
        assert.equal(await fs.readFile(backupPath, "utf-8"), "recover me");
    });
});
