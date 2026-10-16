/* Inline SVG icons. `ic(name, size)` returns markup; `hydrateIcons()` fills every [data-ic]. */

const ICONS = {
  upload:'<path d="M12 15V4m0 0L7 9m5-5 5 5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  doc:'<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  zin:'<circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-3.2-3.2M11 8v6M8 11h6"/>',
  zout:'<circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-3.2-3.2M8 11h6"/>',
  fit:'<path d="M4 9V6a2 2 0 0 1 2-2h3M15 4h3a2 2 0 0 1 2 2v3M20 15v3a2 2 0 0 1-2 2h-3M9 20H6a2 2 0 0 1-2-2v-3"/>',
  width:'<path d="M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4"/>',
  target:'<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  ai:'<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="m18.5 15.5.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  scan:'<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 12h10"/>',
  swap:'<path d="m8 3-4 4 4 4M4 7h16"/><path d="m16 21 4-4-4-4M20 17H4"/>',
  check:'<path d="m4.5 12.5 5 5L20 6.5"/>',
  warn:'<path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4.5M12 17.5v.01"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  x:'<path d="M18 6 6 18M6 6l12 12"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  trash:'<path d="M4 7h16M10 11v6M14 11v6"/><path d="m6 7 1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  flag:'<path d="M5 21V4"/><path d="M5 4c2-.8 4-.8 6 0s4 .8 6 0v8c-2 .8-4 .8-6 0s-4-.8-6 0"/>',
  skip:'<path d="m6 5 7 7-7 7M14 5l7 7-7 7"/>',
  up:'<path d="M12 19V5M5 12l7-7 7 7"/>',
  down:'<path d="M12 5v14M19 12l-7 7-7-7"/>',
  kbd:'<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6.5 10h.01M10.5 10h.01M14 10h.01M17.5 10h.01M6.5 14h.01M17.5 14h.01M9.5 14h5"/>',
  copy:'<rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5.5 15H4.5a2 2 0 0 1-2-2V4.5a2 2 0 0 1 2-2H13a2 2 0 0 1 2 2v1"/>',
  dl:'<path d="M12 3v11m0 0 4-4m-4 4-4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  braces:'<path d="M8.5 3H7a2 2 0 0 0-2 2v3.5A2.5 2.5 0 0 1 2.5 11 2.5 2.5 0 0 1 5 13.5V17a2 2 0 0 0 2 2h1.5M15.5 3H17a2 2 0 0 1 2 2v3.5a2.5 2.5 0 0 0 2.5 2.5 2.5 2.5 0 0 0-2.5 2.5V17a2 2 0 0 1-2 2h-1.5"/>',
  send:'<path d="m21.5 2.5-11 11M21.5 2.5 14 21.5l-2.5-8-8-2.5z"/>',
  reset:'<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1L20.5 8"/><path d="M20.5 3v5h-5"/>',
  file:'<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
};

export const ic = (n,s=16)=>`<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]||''}</svg>`;

export function hydrateIcons(root=document){
  root.querySelectorAll('[data-ic]').forEach(b=> b.insertAdjacentHTML('afterbegin', ic(b.dataset.ic, +(b.dataset.ics||16))));
}
