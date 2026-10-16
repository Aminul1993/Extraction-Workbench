/* Entry point: works out where submitted records go, then starts the workbench. */
import { CONFIG_URL } from './config.js';
import { getJson } from './api.js';
import { startWorkbench } from './workbench.js';

// An unrendered Django placeholder ("{{form_url|escapejs}}") means pms_api didn't render this
// page, so the value comes from GET /config instead.
const unrendered = v => typeof v !== 'string' || v.startsWith('{{');

function readPageConfig(){
  try{ return JSON.parse(document.getElementById('pageConfig')?.textContent || '{}'); }
  catch{ return {}; }
}

// postMessage only uses the origin; anything that isn't a URL disables sending instead of throwing.
function toOrigin(url){
  try{ return url ? new URL(url).origin : null; }catch{ return null; }
}

async function resolveSubmitTarget(){
  const page = readPageConfig();
  let server = {};
  if(unrendered(page.form_type) || unrendered(page.form_url)){
    try{ server = await getJson(CONFIG_URL); }
    catch(err){ console.error('Could not load the page settings', err); }
  }
  return {
    type: unrendered(page.form_type) ? (server.form_type || '') : page.form_type,
    origin: toOrigin(unrendered(page.form_url) ? server.form_url : page.form_url),
  };
}

startWorkbench({ submitTarget: resolveSubmitTarget() });
