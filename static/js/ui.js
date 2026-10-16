/* Toasts and the modal dialog. */
import { el, esc } from './util.js';
import { ic } from './icons.js';

const modalBackdrop = el('modalBackdrop'), modalBox = el('modalBox'), toastHost = el('toastHost');
let modalOpen = false;

export function toast(msg, type='ok'){
  const t=document.createElement('div');
  t.className='toast-item '+type;
  t.innerHTML = ic(type==='ok'?'check':type==='warn'?'warn':'info',14) + `<span>${esc(msg)}</span>`;
  toastHost.appendChild(t);
  requestAnimationFrame(()=>t.classList.add('in'));
  // Warnings explain what went wrong, so they stay up long enough to read.
  setTimeout(()=>{ t.classList.remove('in'); setTimeout(()=>t.remove(),220); }, type==='warn' ? 5000 : 2800);
}

export function openModal(html){
  modalBox.innerHTML = html;
  modalBackdrop.hidden = false; modalOpen = true;
  const f = modalBox.querySelector('button'); if(f) f.focus();
}
export function closeModal(){ modalBackdrop.hidden = true; modalBox.innerHTML=''; modalOpen=false; }
export const isModalOpen = () => modalOpen;

modalBackdrop.addEventListener('mousedown', e=>{ if(e.target===modalBackdrop) closeModal(); });
