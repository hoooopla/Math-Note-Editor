export function splitPath(path: string): string[] {
    const result: string[] = [];
    let current = '';
    let inMath = false;
    for (let i = 0; i < path.length; i++) {
        const char = path[i];
        if (char === '$') {
            inMath = !inMath;
            current += char;
        } else if (char === '/' && !inMath) {
            result.push(current);
            current = '';
        } else {
            current += char;
        }
    }
    result.push(current);
    return result;
}
