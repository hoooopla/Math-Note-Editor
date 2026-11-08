import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import MarkdownIt from 'markdown-it';
import katex from 'katex';
import sanitizeHtml from 'sanitize-html';
import { parseEmbeddedLinks, describeEmbeddedPresentation, splitMathTitle } from '../../src/lib/note-display-core.mjs';

const escape = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const slug = s => encodeURIComponent(s);
const urlFor = note => `${slug(note.id)}.html`;

export function createNoteReader({source, notes, byLabel, errors}) {
const macros = (() => {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(source,'setting','settings.json'),'utf8'));
    const custom = settings.macros && typeof settings.macros === 'object' ? settings.macros : {};
    return settings.emptySetStyle === 'slanted' ? {...custom, '\\emptyset':'\\varnothing'} : custom;
  } catch { return {}; }
})();
const math = (tex, display) => { try { return katex.renderToString(tex,{displayMode:display,throwOnError:false,trust:false,macros}); } catch { return `<code>${escape(tex)}</code>`; } };
function renderTitle(value) {
  return splitMathTitle(String(value)).map(segment=>segment.type==='math'?math(segment.content,false):escape(segment.content)).join('');
}
function assetUrl(src) {
  if (!src) return '';
  if (/^\/api\/assets\//.test(src)) src = src.slice('/api/'.length);
  if (/^(https?:|data:|\/)/i.test(src)) return src;
  const cleaned = path.posix.normalize(decodeURI(src).replaceAll('\\','/'));
  if (!cleaned.startsWith('assets/') || cleaned.includes('..')) return '';
  if (!fs.existsSync(path.join(source, cleaned))) errors.push(`Missing asset: ${cleaned}`);
  return cleaned.split('/').map(encodeURIComponent).join('/');
}
function separateDisplayMath(body) {
  const lines=body.split('\n'), result=[];
  let fence=null;
  for (const line of lines) {
    const marker=/^\s*(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (!fence) fence=marker[1];
      else if (marker[1][0]===fence[0] && marker[1].length>=fence.length) fence=null;
    }
    if (!fence && /^\s*\\\[\s*$/.test(line) && result.at(-1)?.trim()) result.push('');
    result.push(line);
    if (!fence && /^\s*\\\]\s*$/.test(line)) result.push('');
  }
  return result.join('\n');
}
const refs = new Map(notes.map(n => [n.label, new Set()]));
const outgoing = new Map(notes.map(n => [n.label, new Set()]));
let embedSequence = 0;
function reference(raw, note, stack) {
  const parsed = describeEmbeddedPresentation(raw,note.label);
  const {standout,open,label,alias} = parsed;
  const targetLabel = parsed.targetLabel;
  const target = byLabel.get(targetLabel);
  if (!target) { errors.push(`${path.relative(source,note.file)}: missing reference ${targetLabel}`); return {title:`<span class="broken-reference" title="Missing note">${escape(alias || label)}</span>`,body:''}; }
  outgoing.get(note.label).add(target.label); refs.get(target.label).add(note.label);
  const title=alias || target.title;
  const displayTitle=describeEmbeddedPresentation(raw,note.label,title).displayTitle;
  const link = `<a class="note-reference${standout?' standout':''}" href="${urlFor(target)}">${renderTitle(displayTitle)}</a>`;
  if (stack.includes(target.label)) return {title:`${link}<span class="embed-cycle" title="Circular embed: already shown above"> ↩</span>`,body:''};
  const kind=standout?'standout-embed':'inline-embed';
  const id=`embed-body-${++embedSequence}`;
  const button=`<button type="button" class="embed-title ${kind}" aria-expanded="${open}" aria-controls="${id}" data-outline-title="${escape(displayTitle)}">${renderTitle(displayTitle)}</button>`;
  const body=`<div class="note-embed ${kind}" id="${id}"${open?'':' hidden'}><div class="embed-content">${render(target,[...stack,target.label])}</div><a class="embed-open" href="${urlFor(target)}" aria-label="Open ${escape(target.title)} as a note">Open note ↗</a></div>`;
  return {title:standout?`<div class="standout-title-row">${button}</div>`:button,body,standout};
}
function render(note, stack=[note.label]) {
  const md = new MarkdownIt({html:true,linkify:true,typographer:false});
  const linkCache = new Map();
  const linksFor = text => {
    if (!linkCache.has(text)) linkCache.set(text, parseEmbeddedLinks(text));
    return linkCache.get(text);
  };
  const trustedTokens=[];
  const tokenPrefix=`KATEX${crypto.randomUUID().replaceAll('-','')}TOKEN`;
  const trustedToken=value=>{ const index=trustedTokens.push(value)-1; return `${tokenPrefix}${index}END`; };
  const mathToken=(tex,display)=>trustedToken(math(tex,display));
  md.block.ruler.before('paragraph','block_reference',(state,start,end,silent) => {
    const line = state.src.slice(state.bMarks[start]+state.tShift[start],state.eMarks[start]).trim();
    const link=linksFor(line).find(item=>item.from===0 && item.to===line.length);
    if (!link) return false;
    if (silent) return true;
    const token=state.push('block_reference','',0); token.content=link.text; state.line=start+1; return true;
  });
  md.renderer.rules.block_reference = (tokens,i) => {const parts=reference(tokens[i].content,note,stack);return trustedToken(parts.title+parts.body);};
  md.inline.ruler.before('link','note_reference',(state,silent) => {
    if (state.src.slice(state.pos,state.pos+2)!=='[[') return false;
    const link=linksFor(state.src).find(item=>item.from===state.pos);
    if (!link) return false;
    if (!silent) {
      const t=state.push('note_reference','',0);t.content=link.text;
    }
    state.pos=link.to; return true;
  });
  md.renderer.rules.note_reference = (tokens,i) => {const parts=reference(tokens[i].content,note,stack);return trustedToken(parts.title+parts.body);};
  // The title stays in its sentence; the body occupies the next visual row.
  // Splitting here also keeps block content out of a paragraph's HTML DOM.
  md.renderer.rules.note_paragraph = (tokens,i,options,env) => {
    const {children,wrapped}=tokens[i].meta;
    let html='';
    for (const child of children) {
      if (child.type!=='note_reference') { html+=md.renderer.renderInline([child],options,env); continue; }
      const parts=reference(child.content,note,stack);
      const before=parts.body && parts.standout && wrapped?'</p>':'';
      const after=parts.body && wrapped?'<p>':'';
      const separator=parts.body && wrapped && !parts.standout?'</p>':'';
      html+=trustedToken(before+parts.title+separator+parts.body+after);
    }
    return html;
  };
  // The editor treats isolated single underscores as underline, including _underline_.
  md.inline.ruler.before('emphasis','editor_underline',(state,silent)=>{
    const s=state.src,p=state.pos;
    const word=c=>c!==undefined && /[\p{L}\p{N}]/u.test(c);
    if(s[p]!=='_' || s[p-1]==='\\' || s[p-1]==='_' || s[p+1]==='_' || word(s[p-1]) || /\s/.test(s[p+1]||'')) return false;
    let end=-1;
    for(let i=p+1;i<s.length && s[i]!=='\n';i++) {
      if(s[i]==='$' && s[i-1]!=='\\') {const close=s.indexOf('$',i+1);if(close>i){i=close;continue;}}
      if(s.startsWith('\\[',i)) {const close=s.indexOf('\\]',i+2);if(close>i){i=close+1;continue;}}
      if(s[i]==='_' && s[i-1]!=='\\' && s[i-1]!=='_' && s[i+1]!=='_' && !/\s/.test(s[i-1]) && !word(s[i+1])) {end=i;break;}
    }
    if(end<0) return false;
    if(!silent) {const token=state.push('editor_underline','',0);token.content=s.slice(p+1,end);}
    state.pos=end+1;return true;
  });
  md.renderer.rules.editor_underline=(tokens,i)=>`<span class="note-underline">${md.renderInline(tokens[i].content)}</span>`;
  md.inline.ruler.before('escape','inline_math',(state,silent) => {
    const s=state.src, p=state.pos;
    const delim=s.startsWith('\\[',p)?'\\[':s.startsWith('\\(',p)?'\\(':s[p]==='$'&&s[p+1]!=='$'?'$':null;
    if (!delim) return false;
    const end=s.indexOf(delim==='\\['?'\\]':delim==='\\('?'\\)':'$',p+delim.length);
    if (end<0 || end===p+delim.length || s.slice(p+delim.length,end).includes('\n')) return false;
    if (!silent) {const t=state.push(delim==='\\['?'math_inline_display':'math_inline','',0);t.content=s.slice(p+delim.length,end);}
    state.pos=end+(delim==='$'?1:2);return true;
  });
  md.renderer.rules.math_inline=(tokens,i)=>mathToken(tokens[i].content,false);
  md.renderer.rules.math_inline_display=(tokens,i)=>mathToken(tokens[i].content,true);
  md.block.ruler.before('fence','display_math',(state,start,end,silent)=>{
    const line=state.src.slice(state.bMarks[start]+state.tShift[start],state.eMarks[start]).trim();
    const begin=line==='\\['?'\\[':line.startsWith('$$')?'$$':null;
    if (!begin) return false;
    let close=start, content=line.slice(begin.length), stop=begin==='\\['?'\\]':'$$';
    while (!content.includes(stop) && ++close<end) content+='\n'+state.src.slice(state.bMarks[close],state.eMarks[close]);
    const idx=content.indexOf(stop); if (idx<0 || content.slice(idx+stop.length).trim()) return false;
    if (silent) return true;
    const t=state.push('math_display','',0);t.content=content.slice(0,idx);state.line=close+1;return true;
  });
  md.renderer.rules.math_display=(tokens,i)=>mathToken(tokens[i].content,true);
  const defaultImage=md.renderer.rules.image;
  md.renderer.rules.image=(tokens,i,options,env,self)=>{tokens[i].attrSet('src',assetUrl(tokens[i].attrGet('src')));return defaultImage(tokens,i,options,env,self);};
  // KaTeX output is trusted here; authored HTML is restricted before rendering.
  const tokens=md.parse(separateDisplayMath(note.body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'')),{});
  tokens.forEach((token,i)=>{
    if(token.type!=='inline' || tokens[i-1]?.type!=='paragraph_open') return;
    token.children=[{type:'note_paragraph',meta:{children:token.children || [],wrapped:!tokens[i-1].hidden}}];
  });
  const html=md.renderer.render(tokens,md.options,{});
  const clean=sanitizeHtml(html, {allowedTags:[...sanitizeHtml.defaults.allowedTags,'img','span','details','summary','section','div','button'],allowedAttributes:{...sanitizeHtml.defaults.allowedAttributes,a:['href','title','class','aria-label'],img:['src','alt','width','height'],span:['class'],details:['open','class'],section:['class'],div:['class','id'],button:['type','class','aria-expanded','aria-controls','data-outline-title']},allowedSchemes:['http','https','mailto'],transformTags:{img:(tag,attrs)=>({tagName:'img',attribs:{...attrs,src:assetUrl(attrs.src)}})}});
  return clean.replace(new RegExp(`${tokenPrefix}(\\d+)END`,'g'),(_,index)=>trustedTokens[Number(index)] ?? '');
}
  return {render, renderTitle, refs, outgoing};
}
