/* global chrome */

(function injectToolbar() {
  if (document.getElementById('gm-capture-toolbar')) return;
  const bar = document.createElement('div');
  bar.id = 'gm-capture-toolbar';
  Object.assign(bar.style, {
    position: 'fixed', right: '12px', bottom: '12px', zIndex: 2147483647,
    background: '#1a73e8', color: '#fff', padding: '8px 10px', borderRadius: '6px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.2)', fontFamily: 'system-ui, sans-serif',
  });
  const btn = document.createElement('button');
  btn.textContent = 'Capture Tree (coming soon)';
  Object.assign(btn.style, { background: '#fff', color: '#1a73e8', border: 'none', padding: '6px 8px', borderRadius: '4px', cursor: 'pointer' });
  btn.disabled = true;
  bar.appendChild(btn);
  document.body.appendChild(bar);
})();

// Auto-navigation: run in-page to avoid about:blank sandbox issues
(function autoNavigateInPage(){
  const origin=location.origin;
  function toPedigreeFromList(){
    const table=document.querySelector('#gedcoms-table'); if(!table) return false;
    const links=Array.from(table.querySelectorAll('tbody a[href*="/tools/gedcom/individual"]'));
    const trees=links.map(a=>{ const u=new URL(a.getAttribute('href'), origin); const id_family=u.searchParams.get('id_family'); const id_ged=u.searchParams.get('id_ged'); const pedigreeUrl=`${origin}/tools/gedcom/pedigree-chart?id_family=${encodeURIComponent(id_family)}&id_ged=${encodeURIComponent(id_ged)}`; return { individualUrl:u.toString(), pedigreeUrl, email:(a.textContent||'').trim() }; });
    if (trees.length){ const kit=new URL(location.href).searchParams.get('kit_num')||null; try { chrome.runtime.sendMessage({ type:'gm-trees-detected', trees, source: location.href, kit }); } catch(_) {}
      location.assign(trees[0].pedigreeUrl); return true; }
    return false;
  }
  function toPedigreeFromIndividual(){
    const url=new URL(location.href);
    const id_family=url.searchParams.get('id_family'); const id_ged=url.searchParams.get('id_ged');
    if(id_family&&id_ged){ const ped=`${origin}/tools/gedcom/pedigree-chart?id_family=${encodeURIComponent(id_family)}&id_ged=${encodeURIComponent(id_ged)}`; location.assign(ped); return true; }
    return false;
  }
  function run(){
    const path=location.pathname||'';
    if(path.includes('/tools/gedcom/pedigree-chart')) return; // already there
    if(path.includes('/tools/gedcom/find-gedcoms-by-kit')){ toPedigreeFromList(); return; }
    if(path.includes('/tools/gedcom/individual')){ toPedigreeFromIndividual(); return; }
  }
  if(document.readyState==='complete' || document.readyState==='interactive'){ setTimeout(run, 50); }
  else { window.addEventListener('DOMContentLoaded', ()=>setTimeout(run, 50), { once:true }); }
})();
