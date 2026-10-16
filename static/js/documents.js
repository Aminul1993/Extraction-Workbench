/* Turning an uploaded file into a full-resolution canvas of its first page. */

const PDFJS_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38';
let pdfjsPromise = null;

export const isPdf = file => file.type === 'application/pdf' || /\.pdf$/i.test(file.name);

export function renderFirstPage(file){
  return isPdf(file) ? renderPdfFirstPage(file) : loadImageCanvas(file);
}

// pdf.js loads with the first PDF, so a CDN problem affects PDFs rather than the whole page.
function loadPdfJs(){
  pdfjsPromise ??= import(`${PDFJS_BASE}/pdf.min.mjs`).then(lib=>{
    lib.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/pdf.worker.min.mjs`;
    return lib;
  }).catch(err=>{ pdfjsPromise = null; throw err; });
  return pdfjsPromise;
}

async function renderPdfFirstPage(file){
  const pdfjsLib = await loadPdfJs();
  // isEvalSupported:false keeps pdf.js off the font-eval path behind CVE-2024-4367, whatever
  // the version.
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer(), isEvalSupported: false }).promise;
  try{
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 2 });
    const off = document.createElement('canvas');
    off.width = viewport.width; off.height = viewport.height;
    await page.render({ canvasContext: off.getContext('2d'), viewport }).promise;
    return off;
  } finally {
    await pdf.destroy();   // releases the document held by the pdf.js worker
  }
}

async function loadImageCanvas(file){
  const url = URL.createObjectURL(file);
  try{
    const image = new Image();
    image.src = url;
    await image.decode();
    const off = document.createElement('canvas');
    off.width = image.naturalWidth; off.height = image.naturalHeight;
    off.getContext('2d').drawImage(image, 0, 0);
    return off;
  } finally {
    URL.revokeObjectURL(url);
  }
}
