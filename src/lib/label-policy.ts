import { splitPath } from "./utils/path";

export const MAX_BLOCK_LABEL_LENGTH = 512;
export const MAX_BLOCK_TITLE_LENGTH = 512;

const CONTROL_OR_INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u;

export function normalizeBlockLabel(value: string): string {
    return value.normalize("NFC").trim();
}

export function normalizeBlockTitle(value: string): string {
    return value.normalize("NFC").trim();
}

export function validateBlockLabel(value: string): string | null {
    if (!value) return "Label cannot be empty";
    if (value.startsWith("@")) return "Label cannot start with @ because @ is reserved for standout embedded blocks";
    if (value.startsWith("/")) return "Label cannot start with / because / is reserved for relative embedded-block references";
    if (CONTROL_OR_INVISIBLE.test(value)) return "Label cannot contain line breaks, control characters, or invisible direction markers";
    if (Array.from(value).length > MAX_BLOCK_LABEL_LENGTH) return `Label cannot exceed ${MAX_BLOCK_LABEL_LENGTH} characters`;
    return null;
}

export function validateBlockTitle(value: string): string | null {
    if (CONTROL_OR_INVISIBLE.test(value)) return "Title cannot contain line breaks, control characters, or invisible direction markers";
    if (Array.from(value).length > MAX_BLOCK_TITLE_LENGTH) return `Title cannot exceed ${MAX_BLOCK_TITLE_LENGTH} characters`;
    return null;
}

export function validateBlockMetadata(title: string, label: string): string | null {
    return validateBlockTitle(title) || validateBlockLabel(label);
}

function truncateUtf8(value: string, maxBytes: number): string {
    const encoder = new TextEncoder();
    let result = "";
    for (const character of value) {
        if (encoder.encode(result + character).length > maxBytes) break;
        result += character;
    }
    return result;
}

function readableFilenamePart(value: string, fallback: string, maxBytes: number): string {
    const readable = value
        .normalize("NFC")
        .replace(/\\([A-Za-z]+)/g, "$1")
        .replace(/[$\\[\\]{}]/g, "")
        .replace(/[\/\\?%*:|"<>\u0000-\u001f\u007f]/g, "-")
        .replace(/\s+/g, " ")
        .replace(/-+/g, "-")
        .replace(/^[.\s-]+|[.\s-]+$/g, "") || fallback;
    return truncateUtf8(readable, maxBytes).replace(/[.\s-]+$/g, "") || fallback;
}

export function makeBlockFilename(title: string, label: string, id: string): string {
    const titlePart = readableFilenamePart(title, "Untitled", 80);
    const path = splitPath(label).filter(Boolean);
    const contextPart = readableFilenamePart(path.slice(-2).join("-") || label, "block", 80);
    const idPart = readableFilenamePart(id, "id", 40);
    const includeContext = contextPart.toLocaleLowerCase() !== titlePart.toLocaleLowerCase();
    return `${titlePart}${includeContext ? `--${contextPart}` : ""}--${idPart}.md`;
}
