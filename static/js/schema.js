/* The reference schema the workbench reviews against.
   Field metadata for the model this workbench extracts into (e.g. dumped from a DRF
   serializer: {type, required, read_only, and for list fields: many, nested:{sub-schema}}).
   Served by the extraction API from api/reference_schema.json, the same schema /extract maps
   onto. On-screen labels are derived from each key, not stored in the schema. */
import { toTitleCaseFromSnake } from './util.js';

// A field denotes a repeatable "child item" group when its metadata carries a non-empty
// "nested" sub-schema, exactly as api/extraction.py reads it.
function isNestedField(meta){
  const nested = meta && typeof meta==='object' && !Array.isArray(meta) ? meta.nested : null;
  return !!(nested && typeof nested==='object' && !Array.isArray(nested) && Object.keys(nested).length);
}
// Bookkeeping columns (ids, flags, FKs, timestamps) never hold document text, so a group's
// "primary" cell — where box location and re-read text go — is its first real content column.
const NON_CONTENT_TYPES = ['BooleanField','PrimaryKeyRelatedField','DateTimeField','SerializerMethodField'];
function isContentKey(key, meta){
  if(key==='id') return false;
  if(!meta || typeof meta!=='object') return true;
  return !meta.read_only && !NON_CONTENT_TYPES.includes(meta.type);
}

// { groups: [{key, title, itemKeys, primary}], scalarKeys: [...], isEmpty }
export function parseSchema(reference){
  const ref = reference && typeof reference==='object' && !Array.isArray(reference) ? reference : {};
  const groups = Object.keys(ref).filter(k=>isNestedField(ref[k])).map(k=>{
    const nested = ref[k].nested;
    const itemKeys = Object.keys(nested);
    return { key:k, title:toTitleCaseFromSnake(k), itemKeys,
      primary: itemKeys.find(x=>isContentKey(x, nested[x])) || itemKeys[0] };
  });
  const groupKeys = groups.map(g=>g.key);
  return {
    groups,
    scalarKeys: Object.keys(ref).filter(k=>!groupKeys.includes(k)),
    isEmpty: !Object.keys(ref).length,
  };
}

export function groupFor(schema, key){ return schema.groups.find(g=>g.key===key); }
// A group's cells in display order: the primary (content) cell first.
export function cellKeysOf(g){ return g.primary ? [g.primary, ...g.itemKeys.filter(k=>k!==g.primary)] : g.itemKeys; }
