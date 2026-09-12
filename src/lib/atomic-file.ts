import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

export interface AtomicWriteOptions {
    backup?: boolean;
    backupPath?: string;
}

const writeQueues = new Map<string, Promise<void>>();

async function syncDirectory(directory: string) {
    let handle: fs.FileHandle | null = null;
    try {
        handle = await fs.open(directory, "r");
        await handle.sync();
    } catch {
        // Directory fsync is unsupported on some platforms. The file itself has
        // already been flushed, so keep the cross-platform save path usable.
    } finally {
        await handle?.close().catch(() => {});
    }
}

async function replaceFile(targetPath: string, data: string | Buffer, mode?: number) {
    const directory = path.dirname(targetPath);
    await fs.mkdir(directory, { recursive: true });
    const temporaryPath = path.join(
        directory,
        `.${path.basename(targetPath)}.${process.pid}.${crypto.randomUUID()}.tmp`
    );
    let handle: fs.FileHandle | null = null;
    try {
        handle = await fs.open(temporaryPath, "wx", mode);
        await handle.writeFile(data, typeof data === "string" ? { encoding: "utf-8" } : undefined);
        await handle.sync();
        await handle.close();
        handle = null;
        await fs.rename(temporaryPath, targetPath);
        await syncDirectory(directory);
    } catch (error) {
        await handle?.close().catch(() => {});
        await fs.unlink(temporaryPath).catch(() => {});
        throw error;
    }
}

async function backupFileUnlocked(targetPath: string, backupPath = `${targetPath}.bak`) {
    try {
        const [contents, stats] = await Promise.all([fs.readFile(targetPath), fs.stat(targetPath)]);
        await replaceFile(backupPath, contents, stats.mode & 0o777);
        if (backupPath !== `${targetPath}.bak`) await fs.unlink(`${targetPath}.bak`).catch(() => {});
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
}

async function atomicWriteFileUnlocked(targetPath: string, data: string | Buffer, options: AtomicWriteOptions) {
    let mode: number | undefined;
    try {
        mode = (await fs.stat(targetPath)).mode & 0o777;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (options.backup !== false && mode !== undefined) await backupFileUnlocked(targetPath, options.backupPath);
    await replaceFile(targetPath, data, mode);
}

function queueWrite(targetPath: string, operation: () => Promise<void>) {
    const queueKey = path.resolve(targetPath);
    const previous = writeQueues.get(queueKey) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    writeQueues.set(queueKey, current);
    return current.finally(() => {
        if (writeQueues.get(queueKey) === current) writeQueues.delete(queueKey);
    });
}

/**
 * Replaces a file through a flushed temporary file in the same directory.
 * Existing files are copied to `<name>.bak` before the replacement by default.
 */
export function atomicWriteFile(targetPath: string, data: string | Buffer, options: AtomicWriteOptions = {}) {
    return queueWrite(targetPath, () => atomicWriteFileUnlocked(targetPath, data, options));
}

/** Creates or refreshes the sidecar backup without changing the source file. */
export function backupFile(targetPath: string, backupPath?: string) {
    return queueWrite(targetPath, () => backupFileUnlocked(targetPath, backupPath));
}
