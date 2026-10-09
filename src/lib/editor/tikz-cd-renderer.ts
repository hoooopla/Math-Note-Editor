/** The source remains ordinary display math; only its rendering backend changes. */
export function isTikzCdMath(source: string) {
    const opening = /^\s*\\begin\{tikzcd\}(?:\[[^\r\n]*\])?/.exec(source);
    if (!opening) return false;
    const closing = '\\end{tikzcd}';
    const end = source.indexOf(closing, opening[0].length);
    return end >= 0 && source.slice(end + closing.length).trim() === '';
}

type Pending = { id: number; source: string; signal?: AbortSignal; onAbort?: () => void;
    resolve: (value: string) => void; reject: (error: Error) => void };
const results = new Map<string, string>();
const MAX_RESULTS = 64;
const fontData = new Map<string, Promise<string>>();
let frame: HTMLIFrameElement | undefined;
let ready = false;
let sequence = 0;
let active: Pending | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
const queue: Pending[] = [];

function embeddedFont(family: string) {
    let pending = fontData.get(family);
    if (!pending) {
        pending = (async () => {
            const response = await fetch(`${import.meta.env.BASE_URL}vendor/bakoma/fonts/${family}.ttf`);
            if (!response.ok) throw new Error(`Missing TeX font: ${family}`);
            const bytes = new Uint8Array(await response.arrayBuffer());
            let binary = '';
            for (let offset = 0; offset < bytes.length; offset += 8192) {
                binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
            }
            return btoa(binary);
        })().catch(error => {
            fontData.delete(family);
            throw error;
        });
        fontData.set(family, pending);
    }
    return pending;
}

async function selfContainedSvg(svg: string) {
    const families = [...new Set([...svg.matchAll(/font-family=(["'])([a-z0-9]+)\1/gi)]
        .map(match => match[2].toLowerCase()))]
        .filter(family => /^(?:cm|eu|msa|msb)[a-z0-9]+$/.test(family));
    const faces = await Promise.all(families.map(async family =>
        `@font-face{font-family:${family};src:url(data:font/ttf;base64,${await embeddedFont(family)}) format('truetype')}`));
    const opening = svg.indexOf('>');
    if (!svg.trimStart().startsWith('<svg') || opening < 0) throw new Error('Diagram renderer returned invalid SVG.');
    const style = faces.length ? `<style>${faces.join('')}</style>` : '';
    return svg.slice(0, opening + 1) + style + svg.slice(opening + 1);
}

async function finish(error?: Error, svg?: string) {
    const job = active;
    active = undefined;
    clearTimeout(timer);
    if (!job) return;
    if (job.signal && job.onAbort) job.signal.removeEventListener('abort', job.onAbort);
    try {
        if (job.signal?.aborted) return;
        if (error || !svg) throw error ?? new Error('Diagram renderer returned no image.');
        svg = await selfContainedSvg(svg);
        if (job.signal?.aborted) return;
        // Match the app's dark math palette without shifting intentionally
        // colored arrows (a CSS invert filter would change every color).
        const darkSvg = svg
            .replace(/(["'])(?:#fff(?:fff)?|white)\1/gi, '$1#1a1d23$1')
            .replace(/(["'])(?:#000(?:000)?|black)\1/gi, '$1#fff$1');
        const image = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(darkSvg)}`;
        results.delete(job.source);
        results.set(job.source, image);
        while (results.size > MAX_RESULTS) results.delete(results.keys().next().value!);
        job.resolve(image);
    } catch (reason) {
        job.reject(reason instanceof Error ? reason : new Error(String(reason)));
    } finally {
        runNext();
    }
}

function runNext() {
    if (!ready || active || !frame?.contentWindow) return;
    active = queue.shift();
    if (!active) return;
    frame.contentWindow.postMessage({ mathNoteTikz: true, id: active.id, source: active.source }, '*');
    timer = setTimeout(() => {
        // A timed-out engine may still be working. Restart it rather than
        // delivering a late image to the next job.
        frame?.remove();
        frame = undefined;
        ready = false;
        void finish(new Error('Diagram rendering timed out.'));
        ensureFrame();
    }, 20_000);
}

function ensureFrame() {
    if (frame) return;
    window.addEventListener('message', onMessage);
    frame = document.createElement('iframe');
    frame.title = 'Math diagram renderer';
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden;pointer-events:none';
    frame.src = `${import.meta.env.BASE_URL}tikz-renderer.html`;
    document.body.appendChild(frame);
}

function onMessage(event: MessageEvent) {
    if (event.source !== frame?.contentWindow || event.data?.mathNoteTikz !== true) return;
    if (event.data.ready === true) {
        ready = true;
        runNext();
        return;
    }
    if (event.data.id !== active?.id) return;
    if (typeof event.data.error === 'string') void finish(new Error(event.data.error));
    else if (typeof event.data.svg === 'string' && event.data.svg.trimStart().startsWith('<svg')) {
        void finish(undefined, event.data.svg);
    } else void finish(new Error('Diagram renderer returned invalid SVG.'));
}

export function renderTikzCd(source: string, signal?: AbortSignal): Promise<string> {
    const cached = results.get(source);
    if (cached) return Promise.resolve(cached);
    if (source.length > 50_000) return Promise.reject(new Error('Diagram source is too large.'));
    if (signal?.aborted) return Promise.reject(new DOMException('Rendering cancelled.', 'AbortError'));
    ensureFrame();
    return new Promise((resolve, reject) => {
        const job: Pending = { id: ++sequence, source, signal, resolve, reject };
        if (signal) {
            job.onAbort = () => {
                const index = queue.indexOf(job);
                if (index >= 0) queue.splice(index, 1);
                reject(new DOMException('Rendering cancelled.', 'AbortError'));
            };
            signal.addEventListener('abort', job.onAbort, { once: true });
        }
        queue.push(job);
        runNext();
    });
}
