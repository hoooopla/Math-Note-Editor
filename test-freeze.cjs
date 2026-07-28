const fs = require('fs');
const doc = `Let $\\R^7 = \\R\\times\\C^3 = \\{(t,z_1,z_2,z_3)\\}$ be oriented with a vol form $dvol = dt\\,dx_1dy_1dx_2dy_2dx_3dy_3$.
standard Kähler form $\\omega = \\frac{i}{2}\\sum dz_i\\wedge d\\bar z_i = \\sum dx_i\\wedge dy_i$ 
holo. $3$-form $\\Omega = dz_1\\wedge dz_2\\wedge dz_3$ on $\\C^3$
$g$: Euclidean metric.
Standard associative form $\\varphi_0 = dt\\wedge\\omega + \\operatorname{Im}\\Omega = \\sum dt\\wedge dx_i\\wedge dy_i + $.
We have $\\iota_v\\phi \\wedge\\iota_w\\phi \\wedge\\phi = 6 g(v,w)\\, dvol$
proof: extend to $V\\otimes \\C$ we have basis $\\{\\partial_t, \\partial z_i,\\partial\\bar z_i\\}$ $\\textbf{\\textcolor{brown}{undone}}$

$G_2:=\\{A\\in GL(\\R^7): A^* \\phi = \\phi\\}$
$G_2$ preserve metric $g$ and orientation \\mu_0.
pf: Let $A\\in G_2$~> $A^*\\phi = \\phi $`;

let i = 0;
const ranges = [];
while (i < doc.length) {
    if (doc.startsWith("\\[", i)) {
        let end = doc.indexOf("\\]", i + 2);
        if (end !== -1) {
            ranges.push({
                from: i, 
                to: end + 2, 
                text: doc.slice(i + 2, end).trim(),
                type: "blockMath"
            });
            i = end + 2;
            continue;
        }
    }
    i++;
}
i = 0;
while (i < doc.length) {
    const blockOverlap = ranges.find(r => r.type === "blockMath" && i >= r.from && i < r.to);
    if (blockOverlap) {
        i = blockOverlap.to;
        continue;
    }
    if (doc[i] === '$' && doc[i-1] !== '\\') {
        let end = doc.indexOf("$", i + 1);
        while (end !== -1 && doc[end - 1] === '\\') {
            end = doc.indexOf("$", end + 1);
        }
        if (end !== -1) {
            ranges.push({
                from: i, 
                to: end + 1, 
                text: doc.slice(i + 1, end).trim(),
                type: "inlineMath"
            });
            i = end + 1;
            continue;
        }
    }
    i++;
}

const boldRegex = /\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*/g;
let match;
while ((match = boldRegex.exec(doc)) !== null) {
    // ...
}
const italicRegex = /(?<!\*)\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)/g;
while ((match = italicRegex.exec(doc)) !== null) {}

const underlineRegex = /(?<!_)_(?!\s)([^_\n]+?)(?<!\s)_(?!_)/g;
while ((match = underlineRegex.exec(doc)) !== null) {}

const listRegex = /^[ \t]*(\*)(?=\s)/gm;
while ((match = listRegex.exec(doc)) !== null) {}

const quoteRegex = /^[ \t]*(> )(.*)$/gm;
while ((match = quoteRegex.exec(doc)) !== null) {}

console.log("No freeze in katex-plugin main logic");
