/* In-browser OCR with Tesseract.js (loaded by index.html as a global).
   One worker serves the page's lifetime. Tesseract.recognize() builds and tears down a whole
   worker (WASM core and language data) on every call, so each "Re-read box" used to pay that
   start-up again. */

const MIN_LINE_CONFIDENCE = 35;
let workerPromise = null;
let progressListener = ()=>{};

export const ocrAvailable = () => typeof Tesseract !== 'undefined';
export function onOcrProgress(fn){ progressListener = fn; }

function getWorker(){
  if(!ocrAvailable()) return Promise.reject(new Error('Tesseract.js did not load'));
  workerPromise ??= Tesseract.createWorker('eng', 1, { logger: m=>progressListener(m) })
    .catch(err=>{ workerPromise = null; throw err; });
  return workerPromise;
}

// Starts the worker and its downloads before the first document arrives.
export function prewarmOcr(){ if(ocrAvailable()) getWorker().catch(()=>{}); }

// The whole page: text lines with their boxes (to locate values) and the plain text.
export async function recognizePage(image){
  const { data } = await (await getWorker()).recognize(image);
  return {
    lines: (data.lines||[]).filter(l=>l.text.trim() && l.confidence > MIN_LINE_CONFIDENCE),
    text: data.text || '',
  };
}

// One box's crop.
export async function recognizeRegion(image){
  const { data } = await (await getWorker()).recognize(image);
  return { text: (data.text||'').trim(), confidence: data.confidence };
}
