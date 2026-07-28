const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  page.on('console', msg => console.log('BROWSER CONSOLE:', msg.text()));
  page.on('pageerror', err => console.log('BROWSER ERROR:', err.message));

  await page.goto('http://localhost:3000/Math-Note-Editor/');
  await page.waitForSelector('.cm-content');
  
  const text = `Let $\\R^7 = \\R\\times\\C^3 = \\{(t,z_1,z_2,z_3)\\}$ be oriented with a vol form $dvol = dt\\,dx_1dy_1dx_2dy_2dx_3dy_3$.
standard Kähler form $\\omega = \\frac{i}{2}\\sum dz_i\\wedge d\\bar z_i = \\sum dx_i\\wedge dy_i$ 
holo. $3$-form $\\Omega = dz_1\\wedge dz_2\\wedge dz_3$ on $\\C^3$
$g$: Euclidean metric.
Standard associative form $\\varphi_0 = dt\\wedge\\omega + \\operatorname{Im}\\Omega = \\sum dt\\wedge dx_i\\wedge dy_i + $.
We have $\\iota_v\\phi \\wedge\\iota_w\\phi \\wedge\\phi = 6 g(v,w)\\, dvol$
proof: extend to $V\\otimes \\C$ we have basis $\\{\\partial_t, \\partial z_i,\\partial\\bar z_i\\}$ $\\textbf{\\textcolor{brown}{undone}}$

$G_2:=\\{A\\in GL(\\R^7): A^* \\phi = \\phi\\}$
$G_2$ preserve metric $g$ and orientation \\mu_0.
pf: Let $A\\in G_2$~> $A^*\\phi = \\phi $`;

  await page.evaluate(async (text) => {
     const res = await fetch('/api/blocks', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ title: "Test", label: "test5", content: text })
     });
     const json = await res.json();
     localStorage.setItem('openTabs', JSON.stringify([json.id]));
     localStorage.setItem('activeTab', json.id);
     window.location.reload();
  }, text);
  
  await page.waitForTimeout(5000);
  console.log("Still alive");
  await browser.close();
})();
