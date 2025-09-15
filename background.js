/* global chrome */

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ gmGedmatchSession: { profiles: [], queueIndex: 0, bundle: null } });
  // Ensure clicking the action opens the side panel automatically
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
  if (chrome.sidePanel?.setOptions) {
    chrome.sidePanel.setOptions({ path: 'sidepanel.html', enabled: true }).catch(() => {});
  }
});

chrome.action?.onClicked.addListener(async (tab) => {
  try {
    if (chrome.sidePanel?.open) {
      await chrome.sidePanel.open({ windowId: tab?.windowId });
    }
  } catch (e) {
    console.warn('[GM-BG] sidePanel open failed', e);
  }
});

chrome.runtime.onConnect.addListener(port => {
  if (port.name === 'gm-keepalive') {
    port.onMessage.addListener(() => { /* keep service worker alive briefly */ });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'gm:getSession') {
    chrome.storage.local.get('gmGedmatchSession', data => sendResponse(data.gmGedmatchSession || {}));
    return true;
  }
  if (msg?.type === 'gm:saveCapture') {
    chrome.storage.local.get('gmGedmatchSession', store => {
      const s = store.gmGedmatchSession || { profiles: [], queueIndex: 0, bundle: { profiles: [], captures: [] } };
      s.bundle = s.bundle || { profiles: [], captures: [] };
      s.bundle.captures = s.bundle.captures || [];
      s.bundle.captures.push(msg.payload);
      chrome.storage.local.set({ gmGedmatchSession: s }, () => sendResponse({ ok: true }));
    });
    return true;
  }
  if(msg && msg.type==='gm-nav-to-url' && msg.tabId && msg.url){
    chrome.tabs.update(msg.tabId, { url: msg.url }, () => { sendResponse({ ok:true }); });
    return true;
  }
  if(msg && msg.type==='gm-trees-detected'){
    (async ()=>{
      try{
        const store=await chrome.storage.local.get(['gmGedmatchSession']);
        const session=store.gmGedmatchSession||{ profiles:[], queueIndex:0, bundle:null };
        const kit = msg.kit || (session.profiles[session.queueIndex-1]?.Kit);
        if(kit){ const idx=session.profiles.findIndex(p=>p.Kit===kit); if(idx>=0){ session.profiles[idx].__trees=msg.trees||[]; await chrome.storage.local.set({ gmGedmatchSession: session }); } }
        sendResponse({ ok:true });
      } catch(e){ sendResponse({ ok:false, error: String(e) }); }
    })();
    return true;
  }
});
