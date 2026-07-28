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

const regexes = [
    /\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*/g,
    /(?<!\*)\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)/g,
    /(?<!_)_(?!\s)([^_\n]+?)(?<!\s)_(?!_)/g,
    /^[ \t]*(\*)(?=\s)/gm,
    /^[ \t]*(> )(.*)$/gm,
    /%.*/g,
    /\\[a-zA-Z]+/g,
    /\\([{}%$_\\])/g,
    /[{}]/g,
    /[_^]/g,
    /&/g
];
for (const regex of regexes) {
    let start = Date.now();
    let match;
    let i = 0;
    while ((match = regex.exec(doc)) !== null) {
        i++;
    }
    console.log(regex, Date.now() - start, "ms", i, "matches");
}
