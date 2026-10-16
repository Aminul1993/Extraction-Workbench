/* The review workbench: the document pane, the review rail, and the flow from upload to
   submit. Review rules live in review-model.js; this module owns state, rendering and events. */
import { AI_URL, EXTRACT_TIMEOUT_MS, SCHEMA_URL } from './config.js';
import { el, esc, clamp, fmtSize, highlightJson, toTitleCaseFromSnake } from './util.js';
import { ic, hydrateIcons } from './icons.js';
import { parseSchema, groupFor, cellKeysOf } from './schema.js';
import { ApiError, getJson, requestExtraction, extractionFailureMessage } from './api.js';
import { isPdf, renderFirstPage } from './documents.js';
import { ocrAvailable, onOcrProgress, prewarmOcr, recognizePage, recognizeRegion } from './ocr.js';
import { toast, openModal, closeModal, isModalOpen } from './ui.js';
import * as review from './review-model.js';

const { STATUS_LABEL, statusOf, cloneItem } = review;

const PAGE_MAX_W = 760;         // rendered page width in CSS px at 100%
const MIN_W = 0.03, MIN_H = 0.012;

const docScroll = el('docScroll'), stage = el('stage');
const canvas = el('docCanvas'), ctx = canvas.getContext('2d');
const pageWrap = el('pageWrap'), pageScale = el('pageScale'), pageSizer = el('pageSizer');
const markerLayer = el('markerLayer'), queueHost = el('queue'), focusHost = el('focusHost');
const dropzone = el('dropzone'), fileInput = el('fileInput');

let schema = parseSchema({}), schemaLoad = null;
let submitTarget = Promise.resolve({ type:'', origin:null });

let img=null, imgW=0, imgH=0;     // the page at full resolution, as a canvas; OCR reads it
let items=[], baseline=[];        // unified queue: fields AND group rows, boxes normalized 0-1
let ocrLines=[], ocrText='';
let selectedId=null, view='todo', zoom=1, closeup=false, focusKey=null;
let currentFile=null, currentFileName='', extractedAt=null;
let drag=null, jsonActive=false, processing=false, pendingCellFocus=false, handAddedRows=0;
let reviewDirty=false;            // confirmations, edits or moved boxes since the last extraction
let run=null;                     // the document being processed; replaced on upload, cleared on reset
const rereading = new Set();      // ids whose box is being re-read

function todoItems(){ return items.filter(i=>statusOf(i)!=='verified'); }
function verifiedItems(){ return items.filter(i=>statusOf(i)==='verified'); }
function selected(){ return items.find(i=>i.id===selectedId) || null; }
const rowsOf = key => review.rowsOf(items, key);
const labelOf = it => review.labelOf(it, items, schema);
const summaryOf = it => review.summaryOf(it, schema);
const markerFor = id => markerLayer.querySelector(`.marker[data-id="${CSS.escape(id)}"]`);

/* ---------- schema ---------- */
// Loads the schema the first time it's needed; a failed load is retried with the next document.
function ensureSchema(){
  if(!schema.isEmpty) return Promise.resolve(schema);
  schemaLoad ??= getJson(SCHEMA_URL)
    .then(ref=>{ schema = parseSchema(ref); return schema; })
    .catch(err=>{
      console.error('Could not load the reference schema', err);
      toast(err instanceof ApiError
        ? `Could not load the schema — ${err.message}`
        : 'Could not load the schema — is the extraction API running?','warn');
      return schema;
    })
    .finally(()=>{ schemaLoad = null; });
  return schemaLoad;
}

/* ---------- shortcuts panel ---------- */
function openShortcuts(){
  const rows=[
    ['Confirm & move to next','Enter'],['Previous / next item','↑ ↓ J K'],
    ['Edit the value in focus','/'],['Flag / unflag','F'],['Skip','S'],
    ['Re-read box region','R'],['Toggle this panel','?'],
  ];
  openModal(`
    <div class="modal-head">
      <div><div class="modal-title">Keyboard shortcuts</div><div class="modal-sub">Built for fast, mouse-optional review.</div></div>
      <button class="btn btn-icon btn-ghost btn-sm" id="mClose" aria-label="Close">${ic('x',15)}</button>
    </div>
    <div class="modal-body">${rows.map(r=>`
      <div class="sc-row"><span class="sc-desc">${r[0]}</span>
      <span class="sc-keys">${r[1].split(' ').map(k=>`<kbd class="kbd dark">${k}</kbd>`).join('')}</span></div>`).join('')}
    </div>`);
  el('mClose').addEventListener('click', closeModal);
}
el('helpBtn').addEventListener('click', openShortcuts);

/* ---------- navigation ---------- */
function pool(){
  const list = view==='all' ? items : (view==='done' ? verifiedItems() : todoItems());
  return list.length ? list : items;
}
function select(id){
  selectedId = id;
  refresh();
  const row = queueHost.querySelector('.qitem.selected');
  if(row) row.scrollIntoView({block:'nearest', behavior:'smooth'});
}
function step(dir){
  const p = pool();
  const i = p.findIndex(x=>x.id===selectedId);
  select(p[i===-1 ? 0 : (i+dir+p.length)%p.length].id);
}
function advanceFrom(fromId){
  const rest = todoItems().filter(x=>x.id!==fromId);
  if(!rest.length){ selectedId=null; refresh(); return; }
  const from = items.findIndex(x=>x.id===fromId);
  const after = rest.find(x=>items.findIndex(y=>y.id===x.id) > from);
  select((after || rest[0]).id);
}
function confirmItem(id){
  const it = items.find(x=>x.id===id);
  if(!it) return;
  it.confirmed = true; it.flagged = false; it.conf = 1; it.located = true; it.weak = false;
  reviewDirty = true;
  advanceFrom(id);
}
function toggleFlag(it){
  it.flagged = !it.flagged; it.confirmed = false;
  reviewDirty = true;
  refresh();
}
function removeItem(id){
  const idx = items.findIndex(x=>x.id===id);
  if(idx===-1) return;
  items.splice(idx,1);
  reviewDirty = true;
  const rest = todoItems();
  const next = rest.find(x=>items.indexOf(x)>=idx) || rest[0];
  selectedId = next ? next.id : null;
  refresh();
  toast('Row removed','info');
}
function firstPendingId(){
  const t = todoItems();
  return t.length ? t[0].id : (items[0] ? items[0].id : null);
}

/* ---------- keyboard ---------- */
window.addEventListener('keydown', e=>{
  if(isModalOpen()){ if(e.key==='Escape') closeModal(); return; }
  if(e.metaKey || e.ctrlKey || e.altKey) return;
  const typing = e.target && (e.target.tagName==='INPUT' || e.target.tagName==='TEXTAREA');
  const sel = selected();
  if(e.key==='Enter'){
    if(e.target.tagName==='BUTTON') return;
    if(sel && !processing){ e.preventDefault(); confirmItem(sel.id); }
    return;
  }
  if(e.key==='Escape' && typing){ e.target.blur(); return; }
  if(typing || !items.length || processing) return;
  // Letter shortcuts work with Shift or Caps Lock too.
  const key = e.key.length===1 ? e.key.toLowerCase() : e.key;
  if(key==='ArrowDown' || key==='j'){ e.preventDefault(); step(1); }
  else if(key==='ArrowUp' || key==='k'){ e.preventDefault(); step(-1); }
  else if(key==='/'){ e.preventDefault(); const i=focusHost.querySelector('.focus-input')||focusHost.querySelector('.cells input'); if(i) i.focus(); }
  else if(key==='f' && sel){ toggleFlag(sel); }
  else if(key==='s' && sel){ advanceFrom(sel.id); }
  else if(key==='r' && sel){ rereadSelectedBox(); }
  else if(key==='?'){ openShortcuts(); }
});

/* ---------- zoom & focus-follow ---------- */
function zoomFor(){
  if(!closeup) return zoom;
  const sel = selected();
  const cw = docScroll.clientWidth;
  if(!sel || !canvas.width || !cw) return zoom;
  const boxPx = Math.max(120, sel.box.w * canvas.width);
  return Math.round(Math.min(2.2, Math.max(0.6, (cw-120)/boxPx))*100)/100;
}
function applyZoom(){
  if(!img || !docScroll.clientWidth) return;
  const z = zoomFor();
  pageScale.style.transform = `scale(${z})`;
  pageSizer.style.width = Math.round(canvas.width*z)+'px';
  pageSizer.style.height = Math.round(canvas.height*z)+'px';
  el('zoomPct').textContent = Math.round(z*100)+'%';
  el('closeupBtn').classList.toggle('btn-dark', closeup);
}
// The page follows the selection instead of the operator hunting for it. Assign scroll
// offsets synchronously — neither behavior:'smooth' nor a deferred write lands here.
function scrollToSelection(){
  const sel = selected();
  if(!sel || !img || !docScroll.clientWidth) return;
  const z = zoomFor();
  const cx = (sel.box.x + sel.box.w/2) * canvas.width * z;
  const cy = (sel.box.y + sel.box.h/2) * canvas.height * z;
  docScroll.scrollLeft = Math.max(0, cx + 24 - docScroll.clientWidth/2);
  docScroll.scrollTop  = Math.max(0, cy + 24 - docScroll.clientHeight/2);
}
// Re-zooms and re-centres only when the selection or close-up mode actually changed, so
// edits and manual zooms don't yank the page back.
function followSelection(){
  const key = selectedId+'|'+closeup;
  if(key===focusKey) return;
  focusKey = key;
  applyZoom(); scrollToSelection();
}
function setZoom(z){
  closeup = false; zoom = z;
  focusKey = selectedId+'|'+closeup;
  applyZoom();
}
el('zoomInBtn').addEventListener('click', ()=>setZoom(Math.min(2.4, Math.round((zoom+0.1)*100)/100)));
el('zoomOutBtn').addEventListener('click', ()=>setZoom(Math.max(0.3, Math.round((zoom-0.1)*100)/100)));
el('zoomPct').addEventListener('click', ()=>setZoom(1));
el('zoomFitBtn').addEventListener('click', ()=>setZoom(fitZoom()));
el('zoomWidthBtn').addEventListener('click', ()=>setZoom(Math.max(0.3, Math.round(((docScroll.clientWidth-56)/(canvas.width||1))*100)/100)));
el('closeupBtn').addEventListener('click', ()=>{ closeup=!closeup; followSelection(); });
function fitZoom(){
  const avail = docScroll.clientHeight - 52;
  return Math.max(0.3, Math.round(Math.min(1, avail/(canvas.height||1))*100)/100);
}

/* ---------- file handling ---------- */
dropzone.addEventListener('click', ()=>fileInput.click());
dropzone.addEventListener('keydown', e=>{ if(e.key==='Enter' || e.key===' '){ e.preventDefault(); fileInput.click(); } });
dropzone.addEventListener('dragover', e=>{ e.preventDefault(); dropzone.classList.add('drag'); });
dropzone.addEventListener('dragleave', ()=>dropzone.classList.remove('drag'));
dropzone.addEventListener('drop', e=>{
  e.preventDefault(); dropzone.classList.remove('drag');
  if(e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', e=>{ if(e.target.files[0]) handleFile(e.target.files[0]); });
// Start text recognition's downloads as soon as a document looks likely.
['pointerenter','dragenter','focus'].forEach(type=>dropzone.addEventListener(type, prewarmOcr, { once:true }));

function setLoaded(on){
  ['rerunAiBtn','rereadAllBtn','newFileBtn'].forEach(id=>el(id).hidden=!on);
  ['zoomInBtn','zoomOutBtn','zoomFitBtn','zoomWidthBtn','closeupBtn'].forEach(id=>el(id).disabled=!on);
  el('railMid').hidden = !on;
  el('queueZone').hidden = !on || jsonActive;
  el('railFooter').hidden = !on;
}
function hardReset(){
  run?.controller.abort(); run = null;   // anything still in flight for the old document is dropped
  closeModal(); procHide(); setJsonActive(false);
  stage.classList.remove('active');
  dropzone.style.display='';
  docScroll.classList.add('empty');
  setLoaded(false);
  el('submitBtn').disabled = true;
  el('fileChip').classList.remove('loaded');
  el('fileMeta').textContent = 'No document';
  el('fileSize').textContent = '';
  items=[]; baseline=[]; ocrLines=[]; ocrText=''; rereading.clear();
  img=null; currentFile=null; currentFileName=''; extractedAt=null; selectedId=null; focusKey=null;
  drag=null; reviewDirty=false;
  zoom=1; closeup=false; el('zoomPct').textContent='100%';
  fileInput.value='';
  refresh();
}
el('newFileBtn').addEventListener('click', hardReset);
el('resetBtn').addEventListener('click', ()=>{
  if(!items.length){ hardReset(); return; }
  openModal(`
    <div class="modal-head">
      <div><div class="modal-title">Reset workbench?</div>
      <div class="modal-sub">Revert puts every value and box back to what was last extracted. Clear removes the document and all review progress. Neither can be undone.</div></div>
      <button class="btn btn-icon btn-ghost btn-sm" id="mClose" aria-label="Close">${ic('x',15)}</button>
    </div>
    <div class="modal-foot">
      <button class="btn" id="mCancel">Cancel</button>
      ${baseline.length ? `<button class="btn" id="mRevert">${ic('reset',14)} Revert edits</button>` : ''}
      <button class="btn btn-danger" id="mReset">Clear document</button>
    </div>`);
  el('mClose').addEventListener('click', closeModal);
  el('mCancel').addEventListener('click', closeModal);
  if(el('mRevert')) el('mRevert').addEventListener('click', ()=>{
    closeModal();
    items = baseline.map(cloneItem);
    reviewDirty = false;
    selectedId = firstPendingId();
    focusKey = null;
    refresh();
    toast('Reverted to the last extraction','info');
  });
  el('mReset').addEventListener('click', ()=>{ closeModal(); hardReset(); toast('Workbench cleared','info'); });
});

function startRun(file){
  run?.controller.abort();
  run = { file, controller: new AbortController() };
  return run;
}

async function handleFile(file){
  const current = startRun(file);
  currentFile = file; currentFileName = file.name;
  el('fileChip').classList.add('loaded');
  el('fileMeta').textContent = file.name;
  el('fileSize').textContent = ' · ' + fmtSize(file.size);
  try{
    const page = await renderFirstPage(file);
    if(current !== run) return;
    img = page; imgW = page.width; imgH = page.height;
    onDocReady(current);
  }catch(err){
    console.error(err);
    if(current === run) toast('Could not read that file','warn');
  }
}

function onDocReady(current){
  dropzone.style.display = 'none';
  docScroll.classList.remove('empty');
  stage.classList.add('active');
  setLoaded(true);
  el('submitBtn').disabled = false;

  const scale = Math.min(PAGE_MAX_W/imgW, 1);
  canvas.width = Math.round(imgW*scale);
  canvas.height = Math.round(imgH*scale);
  pageWrap.style.width = canvas.width+'px';
  pageWrap.style.height = canvas.height+'px';
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  zoom = fitZoom(); closeup = false;
  applyZoom();
  processDocument(current);
}

/* ---------- processing stepper ---------- */
const STEPS = ['Recognize page text','Map to schema'];
const QUEUE_MSG  = { title:'Building your review queue…', detail:'Reading the page and mapping fields to your schema.' };
const REREAD_MSG = { title:'Re-reading boxes…', detail:'Reading the text under each unconfirmed box.' };
let procEl = null, procMsg = QUEUE_MSG;
// active: the index of the running step, or several when steps run side by side.
function procShow(active, sub, steps=STEPS, msg=QUEUE_MSG){
  const railChanged = !processing || procMsg!==msg;
  processing = true; procMsg = msg;
  if(!procEl){
    procEl = document.createElement('div');
    procEl.className = 'proc-overlay';
    procEl.innerHTML = `<div class="proc-card"><div class="proc-spin"></div><div class="psteps"></div><div class="proc-sub"></div></div>`;
    el('docPane').appendChild(procEl);
  }
  procEl.style.display = 'flex';
  const running = [].concat(active), firstRunning = Math.min(...running);
  procEl.querySelector('.psteps').innerHTML = steps.map((s,i)=>{
    const done = i < firstRunning;
    const st = done ? 'done' : (running.includes(i) ? 'active' : '');
    return `<div class="pstep ${st}"><i>${done ? ic('check',10) : ''}</i><span>${s}</span></div>`;
  }).join('');
  procEl.querySelector('.proc-sub').textContent = sub || '';
  if(railChanged) renderFocus();
}
function procHide(){ processing = false; if(procEl) procEl.style.display = 'none'; }

onOcrProgress(m=>{
  if(!processing || procMsg!==QUEUE_MSG || !procEl) return;   // box re-reads report their own progress
  const sub = procEl.querySelector('.proc-sub');
  if(m.status==='recognizing text') sub.textContent = `recognizing text… ${Math.round(m.progress*100)}%`;
  else if(m.status) sub.textContent = m.status.replace(/[_-]/g,' ');
});

/* ---------- OCR + extraction ---------- */
// AbortSignal.any where the browser has it (Chrome 116, Firefox 124, Safari 17.4); otherwise
// one controller that follows every signal.
function anySignal(signals){
  if(AbortSignal.any) return AbortSignal.any(signals);
  const controller = new AbortController();
  for(const signal of signals){
    if(signal.aborted){ controller.abort(signal.reason); break; }
    signal.addEventListener('abort', ()=>controller.abort(signal.reason), { once:true });
  }
  return controller.signal;
}
function extract(current, pageText=''){
  return Promise.resolve().then(()=>requestExtraction(AI_URL, {
    file: current.file, ocrText: pageText,
    signal: anySignal([current.controller.signal, AbortSignal.timeout(EXTRACT_TIMEOUT_MS)]),
  })).then(value=>({ value }), error=>({ error }));
}
// Nothing in processing should throw, but if something does, the overlay must not stay up.
function recoverFrom(err, current){
  console.error(err);
  if(current !== run) return;
  procHide();
  toast('Something went wrong while reading the document — try Re-extract','warn');
  refresh();
}
// OCR only locates values on the page (boxes + "on the page it reads" suggestions); /extract
// reads the file itself, so for a PDF the two run side by side. An image has no text layer,
// so /extract gets the page's OCR text and waits for it.
async function processDocument(current){
  try{
    procShow([0,1], 'reading the page and mapping fields…');
    const ocr = recognizePage(img).catch(err=>{
      console.error(err);
      if(current===run) toast(ocrAvailable()
        ? 'Text recognition failed — values won’t be located on the page'
        : 'Text recognition unavailable — values won’t be located on the page','warn');
      return { lines: [], text: '' };
    });
    ocr.then(()=>{ if(current===run && processing) procShow(1, 'mapping fields to your schema…'); });
    const extraction = isPdf(current.file) ? extract(current) : ocr.then(page=>extract(current, page.text));
    const [page, result] = await Promise.all([ocr, extraction, ensureSchema()]);
    if(current !== run) return;          // cleared or replaced while we waited
    ocrLines = page.lines; ocrText = page.text;
    applyExtraction(result);
  }catch(err){ recoverFrom(err, current); }
}
async function reextract(current){
  try{
    procShow(1, 'mapping fields to your schema…');
    const [result] = await Promise.all([extract(current, isPdf(current.file) ? '' : ocrText), ensureSchema()]);
    if(current === run) applyExtraction(result);
  }catch(err){ recoverFrom(err, current); }
}
function applyExtraction({ value, error }){
  const page = { lines: ocrLines, width: imgW, height: imgH };
  if(value){
    const next = review.itemsFromRecord(value, schema, page);
    finishExtraction(next, `Extraction complete — ${next.length} items mapped`, 'ok');
  } else {
    console.error(error);
    finishExtraction(review.fieldsFromRawLines(schema, page), extractionFailureMessage(error), 'warn');
  }
}
function finishExtraction(next, msg, type){
  items = next;
  extractedAt = new Date().toISOString();
  reviewDirty = false;
  procHide();
  toast(msg, type);
  baseline = items.map(cloneItem);
  selectedId = firstPendingId();
  focusKey = null;
  refresh();
}

// Re-reads the source image under an item's box, so dragging/resizing a box and re-reading
// picks up whatever text now sits under it — independent of the extraction service.
async function readBoxInto(it){
  const cx = Math.round(it.box.x*imgW), cy = Math.round(it.box.y*imgH);
  const cw = Math.max(1, Math.round(it.box.w*imgW)), ch = Math.max(1, Math.round(it.box.h*imgH));
  const crop = document.createElement('canvas');
  crop.width = cw; crop.height = ch;
  crop.getContext('2d').drawImage(img, cx, cy, cw, ch, 0, 0, cw, ch);
  const current = run;
  try{
    const { text, confidence } = await recognizeRegion(crop);
    if(current !== run || !items.includes(it)) return null;   // re-extracted or cleared meanwhile
    if(it.kind==='field') it.value = text;
    else { const g = groupFor(schema, it.group); if(g.primary) it.cells[g.primary] = text; }
    it.located = true; it.confirmed = false; it.weak = false; it.suggestion = text; it.evidence = text;
    it.conf = Math.min(1, (confidence != null ? confidence : 80)/100);
    // Re-reading must not get round the label check: a box moved over another field's
    // value still waits for the reviewer.
    review.recheckEvidence(it, schema);
    reviewDirty = true;
    return text;
  }catch(err){ console.error(err); return null; }
}
async function rereadSelectedBox(){
  const sel = selected();
  if(!sel || !img || processing || rereading.has(sel.id)) return;
  if(!ocrAvailable()){ toast('Text recognition unavailable','warn'); return; }
  rereading.add(sel.id);
  toast('Re-reading box region…','info');
  try{
    const text = await readBoxInto(sel);
    if(text != null) toast(text ? 'Box re-read' : 'No text found in that box', text ? 'ok' : 'warn');
  }finally{ rereading.delete(sel.id); }
  refresh();
}
async function rereadAllBoxes(){
  if(!img || processing || !items.length) return;
  if(!ocrAvailable()){ toast('Text recognition unavailable','warn'); return; }
  const targets = items.filter(it=>it.located && !it.confirmed);
  if(!targets.length){ toast('No unconfirmed boxes on the page to re-read','info'); return; }
  const current = run;
  for(let i=0;i<targets.length;i++){
    procShow(0, `box ${i+1} of ${targets.length} · ${labelOf(targets[i])}`, ['Re-read marked boxes'], REREAD_MSG);
    await readBoxInto(targets[i]);
    if(current !== run) return;        // the document was cleared or replaced meanwhile
  }
  procHide();
  refresh();
  toast(`Re-read ${targets.length} box${targets.length===1 ? '' : 'es'}`,'ok');
}
el('rereadAllBtn').addEventListener('click', rereadAllBoxes);
el('rerunAiBtn').addEventListener('click', ()=>{
  if(processing || !currentFile) return;
  if(!reviewDirty){ reextract(startRun(currentFile)); return; }
  openModal(`
    <div class="modal-head">
      <div><div class="modal-title">Re-extract this document?</div>
      <div class="modal-sub">A fresh extraction replaces your review so far: confirmations, edits and moved boxes. This can't be undone.</div></div>
      <button class="btn btn-icon btn-ghost btn-sm" id="mClose" aria-label="Close">${ic('x',15)}</button>
    </div>
    <div class="modal-foot">
      <button class="btn" id="mCancel">Cancel</button>
      <button class="btn btn-danger" id="mReextract">${ic('ai',14)} Re-extract</button>
    </div>`);
  el('mClose').addEventListener('click', closeModal);
  el('mCancel').addEventListener('click', closeModal);
  el('mReextract').addEventListener('click', ()=>{ closeModal(); reextract(startRun(currentFile)); });
});

/* ---------- markers ---------- */
function positionMarker(node, b){
  node.style.left = (b.x*100)+'%'; node.style.top = (b.y*100)+'%';
  node.style.width = (b.w*100)+'%'; node.style.height = (b.h*100)+'%';
}
function renderMarkers(){
  markerLayer.innerHTML = '';
  if(!img) return;
  const hasSel = !!selected();
  items.forEach(it=>{
    const s = statusOf(it);
    const isSel = it.id === selectedId;
    const box = document.createElement('div');
    box.className = 'marker '+s+(isSel ? ' selected' : (hasSel ? ' dim' : ''));
    box.dataset.id = it.id;
    positionMarker(box, it.box);
    const tag = document.createElement('div');
    tag.className = 'marker-tag';
    tag.textContent = labelOf(it);
    box.appendChild(tag);
    const grip = document.createElement('div');
    grip.className = 'grip';
    grip.dataset.grip = '1';
    box.appendChild(grip);
    box.addEventListener('pointerdown', e=>startDrag(e, it));
    markerLayer.appendChild(box);
  });
}
// Pointer events, so boxes can be moved and resized with a finger or pen as well as a mouse.
function startDrag(e, it){
  if(e.button !== 0) return;
  e.preventDefault();
  const resize = e.target.dataset.grip === '1';
  selectedId = it.id;
  drag = { mode: resize?'resize':'move', id: it.id, sx: e.clientX, sy: e.clientY, orig: {...it.box} };
  refresh();
  drag.node = markerFor(it.id);
}
window.addEventListener('pointermove', e=>{
  if(!drag) return;
  const it = items.find(x=>x.id===drag.id);
  if(!it) return;
  const rect = pageWrap.getBoundingClientRect();
  const dx = (e.clientX - drag.sx)/rect.width;
  const dy = (e.clientY - drag.sy)/rect.height;
  const o = drag.orig;
  if(drag.mode==='move'){
    it.box.x = clamp(o.x+dx, 0, 1-o.w);
    it.box.y = clamp(o.y+dy, 0, 1-o.h);
  } else {
    it.box.w = clamp(o.w+dx, MIN_W, 1-o.x);
    it.box.h = clamp(o.h+dy, MIN_H, 1-o.y);
  }
  it.located = true;  // a box the reviewer placed by hand counts as located, so "Re-read boxes" includes it
  reviewDirty = true;
  if(drag.node) positionMarker(drag.node, it.box);   // only the dragged box moves
});
const endDrag = ()=>{ drag = null; };
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);

/* ---------- focus card ---------- */
const IDLE_HTML = `<div class="rail-idle">${ic('doc',26)}<strong>No document yet</strong><span>Drop a document on the left and the review queue builds itself here.</span></div>`;
const NOTHING_HTML = `<div class="rail-idle">${ic('info',26)}<strong>Nothing to review</strong><span>The schema has no fields to fill. Check that the extraction API is running, then use Re-extract.</span></div>`;

function focusReason(sel, s, pct){
  if(s==='missing') return 'Nothing was read here. Type the value, or drag its box over the right text on the page.';
  if(s==='verified') return 'Matches the page cleanly. Confirm to lock it in.';
  if(sel.flagged) return 'Flagged for a second look — confirm it once you’ve checked it.';
  if(sel.weak) return sel.kind==='row'
    ? 'The description is on the page, but not every value on its line matches — check each cell.'
    : `Found on the page, but not next to a “${esc(labelOf(sel))}” label — check it belongs to this field.`;
  if(sel.located) return `Only ${pct}% confidence — compare it with the highlighted region on the page.`;
  return 'This value couldn’t be located on the page — check where its box sits.';
}

function renderFocus(){
  if(processing){
    focusHost.innerHTML = `<div class="rail-idle"><div class="idle-spin"></div><strong>${esc(procMsg.title)}</strong><span>${esc(procMsg.detail)}</span></div>`;
    return;
  }
  if(!items.length){ focusHost.innerHTML = img ? NOTHING_HTML : IDLE_HTML; return; }

  const sel = selected();
  if(!sel){
    focusHost.innerHTML = `
      <div class="done-card">
        <div class="done-row">
          <div class="done-check">${ic('check',17)}</div>
          <div>
            <div class="done-title">Everything checked</div>
            <div class="done-sub">${items.length} items confirmed against the page.</div>
          </div>
        </div>
        <button class="btn btn-ok btn-confirm btn-lg" id="doneSubmit" style="width:100%;margin-top:16px;">${ic('send',14)} Submit record</button>
      </div>`;
    el('doneSubmit').addEventListener('click', openSubmit);
    return;
  }

  const s = statusOf(sel);
  const todo = todoItems();
  const idx = todo.findIndex(x=>x.id===sel.id);
  const pct = Math.round((sel.conf||0)*100);
  const reason = focusReason(sel, s, pct);
  const hint = closeup ? 'Close-up follows the field in focus.' : 'Drag the box on the page to adjust position, then Re-read box.';
  const g = sel.kind==='row' ? groupFor(schema, sel.group) : null;
  const showSuggest = sel.kind==='field' && sel.suggestion && sel.suggestion !== sel.value;
  const showConf = s==='review' && sel.located && !sel.weak && !sel.flagged;

  focusHost.innerHTML = `
    <div class="focus-card ${s}">
      <div class="focus-head">
        <div class="fstatus ${sel.flagged ? 'review' : s}"><i></i><span>${sel.flagged ? 'Flagged' : STATUS_LABEL[s]}</span></div>
        <div class="focus-nav">
          <button class="btn btn-icon btn-ghost btn-sm" id="prevBtn" title="Previous (↑)" aria-label="Previous">${ic('up',14)}</button>
          <button class="btn btn-icon btn-ghost btn-sm" id="nextBtn" title="Next (↓)" aria-label="Next">${ic('down',14)}</button>
          <span class="focus-pos">${idx>=0 ? (idx+1)+' / '+todo.length+' left' : 'all clear'}</span>
        </div>
      </div>
      <div class="focus-label">${esc(labelOf(sel))}</div>
      <div class="focus-reason">${reason}</div>
      <div class="focus-hint">${hint}</div>
      ${showConf ? `
        <div class="conf"><div class="conf-bar"><i style="width:${pct}%"></i></div><span>${pct}% match</span></div>` : ''}
      ${sel.kind==='field' ? `
        <div class="input-wrap">
          <input class="focus-input" id="focusInput" value="${esc(sel.value)}"
                 placeholder="Type the value, or drag the box on the page" />
          <span class="input-kbd"><kbd class="kbd dark">/</kbd></span>
        </div>
        ${showSuggest ? `
          <div class="suggest">
            <div class="cap">On the page it reads</div>
            <button id="useSuggest"><span class="val">${esc(sel.suggestion)}</span><span class="use">use</span></button>
          </div>` : ''}
      ` : `
        <div class="cells">
          ${cellKeysOf(g).map((k,i)=>`
            <div class="cell ${i===0 ? 'wide' : ''}">
              <label>${esc(toTitleCaseFromSnake(k))}</label>
              <input data-key="${esc(k)}" class="${String(sel.cells[k]||'').trim() ? '' : 'blank'}" value="${esc(sel.cells[k]||'')}" placeholder="—" />
            </div>`).join('')}
        </div>
      `}
      <div class="focus-actions">
        <button class="btn btn-ok btn-lg btn-confirm" id="confirmBtn">
          ${s==='verified' ? 'Looks right' : 'Confirm'} <span class="kbd">↵</span>
        </button>
        <button class="btn btn-lg" id="skipBtn">${ic('skip',13)} Skip</button>
      </div>
      <div class="focus-sub">
        <button class="btn btn-sm ${sel.flagged ? 'btn-warn-soft' : 'btn-ghost'}" id="flagBtn">
          ${ic('flag',13)} ${sel.flagged ? 'Unflag' : 'Flag for later'} <span class="kbd dark">F</span>
        </button>
        <button class="btn btn-sm btn-ghost" id="focusReread">${ic('scan',13)} Re-read box <span class="kbd dark">R</span></button>
        ${sel.kind==='row' ? `<button class="btn btn-sm btn-bad-ghost" id="removeRowBtn">${ic('trash',13)} Remove row</button>` : ''}
      </div>
    </div>`;

  el('prevBtn').addEventListener('click', ()=>step(-1));
  el('nextBtn').addEventListener('click', ()=>step(1));
  el('confirmBtn').addEventListener('click', ()=>confirmItem(sel.id));
  el('skipBtn').addEventListener('click', ()=>advanceFrom(sel.id));
  el('flagBtn').addEventListener('click', ()=>toggleFlag(sel));
  el('focusReread').addEventListener('click', rereadSelectedBox);
  if(el('removeRowBtn')) el('removeRowBtn').addEventListener('click', ()=>removeItem(sel.id));

  const fi = el('focusInput');
  if(fi){
    fi.addEventListener('input', e=>{
      sel.value = e.target.value; sel.confirmed = false; sel.weak = false; sel.edited = true;
      sel.conf = Math.max(sel.conf||0, 0.9); sel.located = true;
      reviewDirty = true;
      softRefresh();
    });
  }
  if(el('useSuggest')){
    el('useSuggest').addEventListener('click', ()=>{
      sel.value = sel.suggestion; sel.conf = 0.95; sel.confirmed = false; sel.located = true; sel.weak = false;
      sel.edited = true;
      reviewDirty = true;
      refresh();
      toast('Suggestion applied','ok');
    });
  }
  focusHost.querySelectorAll('.cells input').forEach(inp=>{
    inp.addEventListener('input', e=>{
      sel.cells[e.target.dataset.key] = e.target.value;
      sel.confirmed = false; sel.edited = true;
      // A row stays auto-confirmed only while every cell still reads on its line.
      review.recheckEvidence(sel, schema);
      reviewDirty = true;
      e.target.className = e.target.value.trim() ? '' : 'blank';
      softRefresh();
    });
  });
  if(pendingCellFocus){
    pendingCellFocus = false;
    const first = focusHost.querySelector('.cells input');
    if(first) first.focus();
  }
}

/* ---------- queue ---------- */
function renderQueue(){
  if(!items.length){ queueHost.innerHTML=''; return; }
  const sections = [{ title:'Fields', key:null, canAdd:false, list: items.filter(i=>i.kind==='field') }]
    .concat(schema.groups.map(g=>({ title:g.title, key:g.key, canAdd:true, list: rowsOf(g.key) })));

  queueHost.innerHTML = '';
  sections.forEach(sec=>{
    const shown = sec.list.filter(it=>{
      const s = statusOf(it);
      if(view==='all') return true;
      if(view==='done') return s==='verified';
      return s!=='verified';
    });
    if(!shown.length && !sec.canAdd && view==='done') return;

    const left = sec.list.filter(it=>statusOf(it)!=='verified').length;
    const wrap = document.createElement('div');
    wrap.className = 'qsection';
    wrap.innerHTML = `
      <div class="qhead">
        <div class="left">
          <span class="qtitle">${esc(sec.title)}</span>
          <span class="qmeta">${sec.list.length===0 ? 'none' : (left===0 ? 'all checked' : left+' left')}</span>
        </div>
        ${sec.canAdd ? `<button class="btn btn-sm btn-ghost" data-add="${esc(sec.key)}">${ic('plus',12)} Row</button>` : ''}
      </div>
      <div class="qitems"></div>`;
    const host = wrap.querySelector('.qitems');

    if(!shown.length){
      const empty = document.createElement('div');
      empty.className = 'qempty';
      empty.textContent = sec.list.length===0 ? 'Nothing found for this group — add a row by hand.' : 'Nothing in this view.';
      host.appendChild(empty);
    } else {
      shown.forEach(it=>{
        const s = statusOf(it);
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'qitem '+s+(it.id===selectedId ? ' selected' : '');
        row.innerHTML = `
          <span class="qbody">
            <span class="qlbl">${esc(labelOf(it))}</span>
            <span class="qval">${esc(summaryOf(it))}</span>
          </span>
          <span class="qchip ${s}">${s==='verified' ? ic('check',10) : ''}${esc(review.chipOf(it))}</span>`;
        row.addEventListener('click', ()=>select(it.id));
        row.addEventListener('mouseenter', ()=>markerFor(it.id)?.classList.add('peek'));
        row.addEventListener('mouseleave', ()=>markerFor(it.id)?.classList.remove('peek'));
        host.appendChild(row);
      });
    }
    queueHost.appendChild(wrap);
  });

  queueHost.querySelectorAll('[data-add]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const g = groupFor(schema, btn.dataset.add);
      const it = {
        kind:'row', id:'r_'+g.key+'_new_'+(++handAddedRows), group:g.key,
        confirmed:false, flagged:false, located:false, conf:0, cells:{},
        box:{ x:0.06, y:0.5, w:0.45, h:0.04 }
      };
      g.itemKeys.forEach(k=>it.cells[k]='');
      items.push(it);
      reviewDirty = true;
      pendingCellFocus = true;
      select(it.id);
    });
  });
}
document.querySelectorAll('#views .seg-btn').forEach(b=>{
  b.addEventListener('click', ()=>{
    view = b.dataset.view;
    document.querySelectorAll('#views .seg-btn').forEach(x=>x.classList.toggle('active', x===b));
    renderQueue();
  });
});

/* ---------- progress ---------- */
function renderProgress(){
  const c = review.statusCounts(items), total = items.length;
  el('progressFill').style.width = total ? (c.verified/total*100)+'%' : '0%';
  el('doneCount').textContent = c.verified;
  el('totalCount').textContent = total;
  el('plOk').textContent = c.verified;
  el('plWarn').textContent = c.review;
  el('plBad').textContent = c.missing;
  el('cTodo').textContent = todoItems().length;
  el('cAll').textContent = total;
  el('cDone').textContent = c.verified;
  el('submitBtn').disabled = !total;
}

/* ---------- JSON panel ---------- */
const currentJson = () => review.buildJson(items, schema, { fileName: currentFileName, extractedAt });
function renderJson(){
  el('jsonView').innerHTML = highlightJson(JSON.stringify(currentJson(), null, 2));
  el('jsonCap').textContent = `Extracted record · ${items.length} items`;
}
function updateJsonIfActive(){ if(jsonActive) renderJson(); }
function setJsonActive(on){
  jsonActive = on;
  el('queueZone').hidden = on || !items.length;
  el('jsonZone').hidden = !on;
  el('views').hidden = on;
  el('jsonCap').hidden = !on;
  el('jsonToggleBtn').classList.toggle('btn-dark', on);
  if(on) renderJson();
}
el('jsonToggleBtn').addEventListener('click', ()=>setJsonActive(!jsonActive));
el('copyJsonBtn').addEventListener('click', async ()=>{
  try{ await navigator.clipboard.writeText(JSON.stringify(currentJson(), null, 2)); toast('JSON copied to clipboard','ok'); }
  catch(e){ toast('Copy failed','warn'); }
});
el('downloadJsonBtn').addEventListener('click', ()=>{
  const blob = new Blob([JSON.stringify(currentJson(), null, 2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (currentFileName.replace(/\.[^.]+$/,'') || 'record') + '.json';
  a.click();
  // Revoking straight away can cancel the download in some browsers.
  setTimeout(()=>URL.revokeObjectURL(a.href), 1000);
  toast('JSON downloaded','ok');
});

/* ---------- submit ---------- */
function openSubmit(){
  const c = review.statusCounts(items);
  openModal(`
    <div class="modal-head">
      <div><div class="modal-title">Submit record</div>
      <div class="modal-sub">${items.length} items · ${c.verified} confirmed · ${c.review} need review · ${c.missing} not found</div></div>
      <button class="btn btn-icon btn-ghost btn-sm" id="mClose" aria-label="Close">${ic('x',15)}</button>
    </div>
    <div class="modal-body"><pre class="modal-json">${highlightJson(JSON.stringify(review.buildSubmitJson(items, schema), null, 2))}</pre></div>
    <div class="modal-foot">
      <button class="btn" id="mCancel">Cancel</button>
      <button class="btn btn-primary" id="mSubmit">${ic('send',14)} Submit record</button>
    </div>`);
  el('mClose').addEventListener('click', closeModal);
  el('mCancel').addEventListener('click', closeModal);
  el('mSubmit').addEventListener('click', doSubmit);
}
async function doSubmit(){
  const data = review.buildSubmitJson(items, schema);
  closeModal();
  const { type, origin } = await submitTarget;
  // Send data back to the Angular parent window that opened this workbench. The browser
  // delivers it only while that window is still on the configured origin.
  const parent = window.opener && !window.opener.closed ? window.opener : null;
  if(parent && origin){
    parent.postMessage({ type, data }, origin);
    toast('Record sent to the form','ok');
    return;
  }
  const why = parent ? 'The form’s address isn’t configured (FORM_URL)' : 'No form window to send to';
  try{
    await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    toast(`${why} — JSON copied instead`,'warn');
  }catch(e){ toast(`${why}, and the JSON couldn’t be copied`,'warn'); }
}
el('submitBtn').addEventListener('click', openSubmit);

/* ---------- mobile panes ---------- */
document.querySelectorAll('.ps-btn').forEach(b=>{
  b.addEventListener('click', ()=>{
    document.body.dataset.pane = b.dataset.pane;
    document.querySelectorAll('.ps-btn').forEach(x=>x.classList.toggle('active', x===b));
    if(b.dataset.pane==='doc'){ applyZoom(); scrollToSelection(); }
  });
});

/* ---------- refresh orchestration ---------- */
function refresh(){
  renderMarkers();
  renderFocus();
  renderQueue();
  renderProgress();
  updateJsonIfActive();
  followSelection();
}
function softRefresh(){
  renderMarkers();
  renderQueue();
  renderProgress();
  updateJsonIfActive();
}

window.addEventListener('resize', ()=>{ if(img) applyZoom(); });

// target: a promise of { type, origin } for the parent form (see main.js).
export function startWorkbench({ submitTarget: target }){
  submitTarget = target;
  hydrateIcons();
  setLoaded(false);
  renderProgress();
  ensureSchema();
}
