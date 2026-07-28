const fs = require('fs');
let code = fs.readFileSync('src/lib/editor/embedded-block-plugin.tsx', 'utf-8');
code = code.replace(
`                    text={this.text}
                    parentLabel={this.parentLabel}
                    visitedLabels={this.visitedLabels}
                    view={view}
                    pos={this.from}
                    length={this.to - this.from}
                    isAtEndOfLine={this.isAtEndOfLine}
                    isAtStartOfLine={this.isAtStartOfLine}`,
`                    text={this.text}
                    parentLabel={this.parentLabel}
                    visitedLabels={this.visitedLabels}
                    view={view}
                    stateRef={this.stateRef}
                    isAtEndOfLine={this.isAtEndOfLine}
                    isAtStartOfLine={this.isAtStartOfLine}`
);
fs.writeFileSync('src/lib/editor/embedded-block-plugin.tsx', code);
