/* Review rules: item status, locating extracted values on the page, and the records the
   workbench exports. Pure functions with no DOM access, so they also run under `node --test`.

   Items are either fields ({kind:'field', field, label, value}) or line-item rows
   ({kind:'row', group, cells}); both carry box (normalized 0-1), located, conf, confirmed,
   flagged, weak (located, but the page doesn't tie the value to this field), evidence (the
   OCR text the item was located on) and edited (the reviewer changed the value). */
import { round1, toTitleCaseFromSnake } from './util.js';
import { groupFor, cellKeysOf } from './schema.js';

export const HIGH = 0.85;              // confidence at or above which a located value counts as verified
export const WEAK_MATCH_CONF = 0.6;    // on the page, but nothing ties the value to this field

/* ---------- status model ----------
   verified — confirmed by the user, or high-confidence and located beside its label
   review   — extracted but uncertain (low confidence, unplaced, weak match, or flagged)
   missing  — nothing extracted at all                                          */
export const STATUS_LABEL = { verified:'Confirmed', review:'Needs a look', missing:'Not found' };

export function isEmptyItem(it){
  if(it.kind==='field') return !String(it.value||'').trim();
  return !Object.keys(it.cells).some(k=>String(it.cells[k]||'').trim());
}
export function statusOf(it){
  if(it.confirmed) return 'verified';
  if(it.flagged) return 'review';
  if(isEmptyItem(it)) return 'missing';
  if(!it.located || (it.conf||0) < HIGH) return 'review';
  return 'verified';
}
export function statusCounts(items){
  const counts = { verified:0, review:0, missing:0 };
  items.forEach(i=>{ counts[statusOf(i)]++; });
  return counts;
}
// Who vouched for a verified item: the reviewer confirmed it, the reviewer changed it without
// confirming ('edited'), or the automatic check against the page passed.
export function verifiedBy(it){
  if(it.confirmed) return 'reviewer';
  if(statusOf(it)!=='verified') return null;
  return it.edited ? 'edited' : 'auto';
}

export function rowsOf(items, key){ return items.filter(i=>i.group===key); }
export function labelOf(it, items, schema){
  if(it.kind==='field') return it.label;
  return groupFor(schema, it.group).title.replace(/([^s])s$/,'$1') + ' ' + (rowsOf(items, it.group).indexOf(it)+1);
}
export function summaryOf(it, schema){
  if(it.kind==='field') return it.value || 'nothing found';
  const vals = cellKeysOf(groupFor(schema, it.group)).map(k=>it.cells[k]).filter(v=>String(v||'').trim());
  return vals.length ? vals.join(' · ') : 'empty row';
}
export function chipOf(it){
  const s = statusOf(it);
  if(s==='missing') return 'not found';
  if(it.confirmed) return 'ok';
  if(it.flagged) return 'flagged';
  if(!it.located) return 'unplaced';
  if(it.weak && s==='review') return it.kind==='row' ? 'check cells' : 'check label';
  return Math.round((it.conf||0)*100)+'%';
}

/* ---------- locating values on the page ---------- */
const WORD_CHAR = /[\p{L}\p{N}]/u;
// Matching ignores case, runs of whitespace and thousands separators ("9,000.00" = "9000.00").
export function normText(s){
  return String(s ?? '').toLowerCase().replace(/(\d),(?=\d{3}(?!\d))/g, '$1').replace(/\s+/g, ' ').trim();
}
// `needle` occurs in `hay` as whole tokens: "co" matches "denver, co" but not "construction"
// or ".com", and "750" doesn't match inside "7500".
export function hasToken(hay, needle){
  if(!needle) return false;
  for(let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i+1)){
    const before = hay[i-1], after = hay[i+needle.length];
    if(!(before && WORD_CHAR.test(before)) && !(after && WORD_CHAR.test(after))) return true;
  }
  return false;
}
// OCR lines that contain the whole value.
export function linesContaining(lines, value){
  const v = normText(value);
  return v.length < 2 ? [] : lines.filter(l=>hasToken(normText(l.text), v));
}
// The line also carries a word of the field's label ("Tax" for tax_amount, "Subtotal" for subtotal).
export function lineHasLabel(line, key){
  const text = normText(line.text);
  return key.toLowerCase().split('_').filter(w=>w.length > 2 && w !== 'and' && w !== 'the')
    .some(w=>hasToken(text, w) || hasToken(text, w.replace(/s$/, '')));
}
// Every filled cell of a line-item row reads on the same line: quantities, prices and totals included.
export function lineHasAllCells(line, row, group){
  const text = normText(line.text);
  return group.itemKeys.every(k=>{ const v = normText(row.cells[k]); return !v || hasToken(text, v); });
}

// Where a box goes when its value can't be found on the page — kept inside the page so
// every marker stays reachable, whatever the schema size.
export function fallbackBox(i, kind){
  if(kind==='row') return { x:0.06, y:Math.min(0.6+i*0.05, 0.93), w:0.5, h:0.04 };
  const col = Math.floor(i/18)%2;
  return { x:0.04+col*0.5, y:0.04+(i%18)*0.052, w:0.42, h:0.04 };
}
// page = { lines, width, height }: the OCR lines and the pixel size they were read at.
export function placeFromMatch(target, match, fallback, fallbackConf, page){
  if(match){
    target.box = { x: match.bbox.x0/page.width, y: match.bbox.y0/page.height,
      w: (match.bbox.x1-match.bbox.x0)/page.width, h: (match.bbox.y1-match.bbox.y0)/page.height };
    target.located = true;
    target.conf = Math.min(1, (match.confidence||70)/100);
    // What the page itself reads there — offered as a one-click suggestion when it
    // differs from the extracted value.
    target.suggestion = match.text.trim();
    target.evidence = match.text;
  } else {
    target.box = { ...fallback };
    target.located = false;
    target.conf = fallbackConf;
    target.suggestion = '';
    target.evidence = '';
  }
}

// After a value or its box changes (a re-read, an edited cell), holds it to the same rule as
// at extraction: a field's evidence must carry a word of its label, a row's evidence every
// filled cell. Only ever lowers confidence; the reviewer confirms anything that falls short.
export function recheckEvidence(it, schema){
  if(!it.located || !it.evidence) return;
  const line = { text: it.evidence };
  const supported = it.kind==='row'
    ? lineHasAllCells(line, it, groupFor(schema, it.group))
    : hasToken(normText(it.evidence), normText(it.value)) && lineHasLabel(line, it.field);
  if(!supported){
    it.weak = true;
    it.conf = Math.min(it.conf, WEAK_MATCH_CONF);
  }
}

// Review items for an extracted record ({field: value, group: [{cell: value}]}).
export function itemsFromRecord(record, schema, page){
  const next = [];
  schema.scalarKeys.forEach((key,i)=>{
    const value = record[key] != null ? String(record[key]) : '';
    const it = { kind:'field', id:'f_'+key, field:key, group:null,
      label: toTitleCaseFromSnake(key), value, confirmed:false, flagged:false };
    const lines = linesContaining(page.lines, value);
    const labelled = lines.find(l=>lineHasLabel(l, key));
    placeFromMatch(it, labelled || lines[0], fallbackBox(i,'field'), value ? 0.5 : 0, page);
    // On the page but not beside its label: it may be another field's value (the BILL TO
    // company read as the vendor), so it waits for a person.
    it.weak = it.located && !labelled;
    if(it.weak) it.conf = Math.min(it.conf, WEAK_MATCH_CONF);
    next.push(it);
  });
  schema.groups.forEach(g=>{
    const rows = Array.isArray(record[g.key]) ? record[g.key] : [];
    rows.forEach((row,i)=>{
      const it = { kind:'row', id:'r_'+g.key+'_'+i, group:g.key, confirmed:false, flagged:false, cells:{} };
      g.itemKeys.forEach(k=>{ it.cells[k] = row && row[k] != null ? String(row[k]) : ''; });
      const lines = linesContaining(page.lines, it.cells[g.primary]);
      const whole = lines.find(l=>lineHasAllCells(l, it, g));
      placeFromMatch(it, whole || lines[0], fallbackBox(i,'row'), 0.5, page);
      // The description alone isn't enough: a quantity, price or total that doesn't read on
      // the row's line keeps the row in review.
      it.weak = it.located && !whole;
      if(it.weak) it.conf = Math.min(it.conf, WEAK_MATCH_CONF);
      next.push(it);
    });
  });
  return next;
}

// Fallback when the extraction service fails: match each scalar schema key against a
// "label: value" OCR line. Line items have no reliable raw-OCR fallback — they're added by hand.
export function fieldsFromRawLines(schema, page){
  return schema.scalarKeys.map((key,i)=>{
    const display = toTitleCaseFromSnake(key);
    const wanted = normText(display);
    let value='', match=null;
    for(const l of page.lines){
      const text = l.text.trim();
      const c = text.indexOf(':');
      if(c<=0 || c>=30) continue;
      const label = normText(text.slice(0,c));
      if(hasToken(label, wanted) || hasToken(wanted, label)){ value = text.slice(c+1).trim(); match = l; break; }
    }
    const it = { kind:'field', id:'f_'+key, field:key, group:null, label:display, value, confirmed:false, flagged:false };
    placeFromMatch(it, match, fallbackBox(i,'field'), 0, page);
    // Pattern-matched values are a stopgap, so they always wait for a person.
    if(it.located) it.conf = Math.min(it.conf, WEAK_MATCH_CONF);
    return it;
  });
}

export function cloneItem(it){ return { ...it, box:{...it.box}, cells: it.cells ? {...it.cells} : undefined }; }

/* ---------- payloads ---------- */
function boxPct(box){
  return { x_pct: round1(box.x*100), y_pct: round1(box.y*100),
    width_pct: round1(box.w*100), height_pct: round1(box.h*100) };
}
export function cellData(row, g){
  const o = {};
  g.itemKeys.forEach(k => o[k] = row.cells[k]);
  return o;
}
// Full review record (status, confidence and box per item) — what the JSON panel shows and copies.
export function buildJson(items, schema, { fileName='', extractedAt=null } = {}){
  const out = {
    file: fileName,
    extracted_at: extractedAt,
    fields: items.filter(i=>i.kind==='field').map(f=>({
      key: f.field, label: f.label, value: f.value,
      status: statusOf(f), verified_by: verifiedBy(f),
      confidence: round1((f.conf||0)*100),
      bounding_box: boxPct(f.box),
    })),
  };
  schema.groups.forEach(g=>{
    out[g.key] = rowsOf(items, g.key).map(row=>({
      label: labelOf(row, items, schema),
      ...cellData(row, g),
      status: statusOf(row), verified_by: verifiedBy(row),
      bounding_box: boxPct(row.box),
    }));
  });
  return out;
}
// What the parent form receives: { field_key: value, ..., group_key: [ {cell_key: value}, ... ] }.
export function buildSubmitJson(items, schema){
  const out = {};
  items.filter(i=>i.kind==='field').forEach(f=>{ out[f.field] = f.value; });
  schema.groups.forEach(g=>{ out[g.key] = rowsOf(items, g.key).map(row => cellData(row, g)); });
  return out;
}
