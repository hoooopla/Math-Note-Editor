let current = null;
const send = message => parent.postMessage({ mathNoteTikz: true, ...message }, '*');

document.addEventListener('tikzjax-load-finished', event => {
  if (current === null) return;
  const svg = event.target;
  if (!(svg instanceof SVGSVGElement)) return;
  send({ id: current, svg: svg.outerHTML });
  svg.remove();
  current = null;
});

new MutationObserver(records => {
  if (current === null) return;
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (!(node instanceof HTMLImageElement) || !node.src.includes('invalid.site/img-not-found.png')) continue;
      node.remove();
      send({ id: current, error: 'Could not compile the tikzcd diagram. Check its LaTeX source.' });
      current = null;
      return;
    }
  }
}).observe(document.body, { childList: true, subtree: true });

addEventListener('message', event => {
  if (event.source !== parent || current !== null || !event.data || event.data.mathNoteTikz !== true) return;
  const { id, source } = event.data;
  if (typeof id !== 'number' || typeof source !== 'string') return;
  current = id;
  const script = document.createElement('script');
  script.type = 'text/tikz';
  script.textContent = '\\usepackage{tikz-cd}\n\\begin{document}\n' + source + '\n\\end{document}';
  document.body.appendChild(script);
});

send({ ready: true });
