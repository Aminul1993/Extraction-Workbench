/* Calls to the extraction API. This page's own query string (form_type, a launch token, …)
   goes along on every call, so the API sees the same context the page was opened with. */

export class ApiError extends Error {
  constructor(message, status){ super(message); this.name = 'ApiError'; this.status = status; }
}

// The API's error shape is {request_status: 0, msg}; keep its message for the reviewer.
async function errorFrom(res){
  const body = await res.json().catch(()=>null);
  return new ApiError(body?.msg || `${res.status} ${res.statusText}`, res.status);
}

export async function getJson(url, { timeoutMs = 10_000 } = {}){
  const res = await fetch(url + window.location.search, { signal: AbortSignal.timeout(timeoutMs) });
  if(!res.ok) throw await errorFrom(res);
  return res.json();
}

// Sends the document as multipart/form-data. An image has no text layer for the API to read,
// so the page's own OCR text goes with it.
export async function requestExtraction(url, { file, ocrText = '', signal }){
  const form = new FormData();
  form.append('file', file, file.name);
  if(ocrText) form.append('ocr_text', ocrText);
  const res = await fetch(url + window.location.search, { method:'POST', body: form, signal });
  if(!res.ok) throw await errorFrom(res);
  return unwrapRecord(await res.json().catch(()=>null));
}

// pms_api replied with the model's raw message ({message:{content}} or a JSON string); the
// Flask API replies with the record itself. Both are accepted.
export function unwrapRecord(data){
  const raw = typeof data==='string' ? data : data?.message?.content;
  const record = raw != null ? safeParseJson(String(raw)) : data;
  if(!record || typeof record!=='object' || Array.isArray(record)) throw new ApiError('Extraction did not return a JSON record');
  return record;
}
export function safeParseJson(text){
  try{ return JSON.parse(text); }catch(e){}
  const s=text.indexOf('{'), e2=text.lastIndexOf('}');
  if(s!==-1 && e2>s){ try{ return JSON.parse(text.slice(s,e2+1)); }catch(e){} }
  return null;
}

// Why extraction fell back to matching "label: value" lines, in words the reviewer can act on.
export function extractionFailureMessage(err){
  const why = err?.status===422 ? 'No readable text for the extraction service'
    : err?.name==='TimeoutError' ? 'Extraction timed out'
    : err instanceof ApiError ? `Extraction failed: ${err.message}`
    : 'Extraction service unreachable';
  return `${why} — matched “label: value” lines on the page instead`;
}
