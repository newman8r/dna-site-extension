/* global chrome */

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
