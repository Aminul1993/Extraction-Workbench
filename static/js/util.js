/* Small helpers shared by the workbench modules. Only `el` touches the DOM. */

export const el = id => document.getElementById(id);

export function toTitleCaseFromSnake(text){
  if(!text) return '';
  return text.toLowerCase().split('_').map(w=>w.charAt(0).toUpperCase()+w.slice(1)).join(' ');
}
export function esc(s){ return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
export function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }
export function round1(n){ return Math.round(n*10)/10; }
export const fmtSize = b => b<1024 ? b+' B' : b<1048576 ? (b/1024).toFixed(1)+' KB' : (b/1048576).toFixed(1)+' MB';

// Pretty-printed JSON with keys, strings, numbers and booleans wrapped for colouring.
export function highlightJson(raw){
  const s = raw.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return s.replace(/("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
    (m, str, col, bool)=>{
      if(str) return `<span class="${col ? 'j-key' : 'j-str'}">${str}</span>${col||''}`;
      if(bool) return `<span class="j-bool">${bool}</span>`;
      return `<span class="j-num">${m}</span>`;
    });
}
