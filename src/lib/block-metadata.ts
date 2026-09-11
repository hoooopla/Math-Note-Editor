import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { parseEmbeddedLinks } from "./embedded-link-syntax";

export function computeReferences(content: string): string[] {
    return Array.from(new Set(
        parseEmbeddedLinks(content)
            .map(link => link.label.trim())
            .filter(Boolean)
    ));
}

export function parseFrontmatter(text: string): { data: Record<string, unknown>; content: string } {
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)/);
    if (!match) return { data: {}, content: text };

    try {
        const parsed = parseYaml(match[1]);
        const data = parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : {};
        return { data, content: match[2] };
    } catch {
        // Keep malformed files readable; callers can fall back to filenames for
        // identity and the metadata editor can repair them on a later save.
        return { data: {}, content: match[2] };
    }
}

export function stringifyFrontmatter(data: Record<string, unknown>, content: string): string {
    const { references: _derivedReferences, ...persistentData } = data;
    const yaml = stringifyYaml(persistentData, { lineWidth: 0 }).trimEnd();
    return `---\n${yaml}\n---\n${content}`;
}

export function metadataText(value: unknown, fallback = ""): string {
    if (value === undefined || value === null) return fallback;
    return String(value).normalize("NFC");
}
