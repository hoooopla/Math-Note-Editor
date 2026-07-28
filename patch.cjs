const fs = require('fs');
let code = fs.readFileSync('src/lib/editor/embedded-block-plugin.tsx', 'utf-8');

code = code.replace(
`    constructor(
        public text: string, 
        public parentLabel: string, 
        public visitedLabels: string[],
        public from: number, 
        public to: number,
        public isAtEndOfLine: boolean = false,
        public isAtStartOfLine: boolean = false
    ) {
        super();
    }`,
`    public stateRef: { pos: number, length: number };
    constructor(
        public text: string, 
        public parentLabel: string, 
        public visitedLabels: string[],
        public from: number, 
        public to: number,
        public isAtEndOfLine: boolean = false,
        public isAtStartOfLine: boolean = false,
        existingStateRef?: { pos: number, length: number }
    ) {
        super();
        this.stateRef = existingStateRef || { pos: from, length: to - from };
        this.stateRef.pos = from;
        this.stateRef.length = to - from;
    }`
);

code = code.replace(
`    eq(other: EmbeddedBlockWidget) {
        return other.text === this.text && other.parentLabel === this.parentLabel && JSON.stringify(other.visitedLabels) === JSON.stringify(this.visitedLabels) && other.from === this.from && other.to === this.to && other.isAtEndOfLine === this.isAtEndOfLine && other.isAtStartOfLine === this.isAtStartOfLine;
    }`,
`    eq(other: EmbeddedBlockWidget) {
        if (other.text === this.text && other.parentLabel === this.parentLabel && JSON.stringify(other.visitedLabels) === JSON.stringify(this.visitedLabels) && other.isAtEndOfLine === this.isAtEndOfLine && other.isAtStartOfLine === this.isAtStartOfLine) {
            other.stateRef.pos = this.from;
            other.stateRef.length = this.to - this.from;
            this.stateRef = other.stateRef;
            return true;
        }
        return false;
    }`
);

code = code.replace(
`                pos={this.from}
                length={this.to - this.from}`,
`                stateRef={this.stateRef}`
);

fs.writeFileSync('src/lib/editor/embedded-block-plugin.tsx', code);
