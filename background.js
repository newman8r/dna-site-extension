/* global chrome */

let gmWatchedParentTabId = null;
let gmWatchExpiresAt = 0;

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
  if (msg && msg.type === 'gm-nav-to-url' && msg.tabId && msg.url) {
    chrome.tabs.update(msg.tabId, { url: msg.url }, () => { sendResponse({ ok:true }); });
    return true;
  }
  if (msg && msg.type === 'gm-trees-detected'){
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
  if (msg && msg.type === 'gm:watchChildTabs' && typeof msg.parentTabId === 'number') {
    gmWatchedParentTabId = msg.parentTabId;
    gmWatchExpiresAt = Date.now() + 20000;
    sendResponse({ ok:true });
    return true;
  }
});

// Track segment results tab by URL
try{
  chrome.webNavigation?.onCommitted.addListener(async (details)=>{
    try{
      const url=details.url||'';
      if(/https:\/\/pro\.gedmatch\.com\/tools\/multi-kit-analysis\/segment-search/i.test(url)){
        await chrome.storage.local.set({ gmSegmentResultsTabId: details.tabId, gmSegmentResultsWhen: Date.now() });
      }
    }catch(_e){}
  });
  chrome.webNavigation?.onCompleted.addListener(async (details)=>{
    try{
      const url=details.url||'';
      if(/https:\/\/pro\.gedmatch\.com\/tools\/multi-kit-analysis\/segment-search/i.test(url)){
        await chrome.storage.local.set({ gmSegmentResultsTabId: details.tabId, gmSegmentResultsWhen: Date.now() });
      }
    }catch(_e){}
  });
} catch(_e) {}

// Track child tab opened from watched parent (openerTabId)
try{
  chrome.tabs.onCreated.addListener(async (tab)=>{
    try{
      if(!gmWatchedParentTabId || Date.now()>gmWatchExpiresAt) return;
      if(tab.openerTabId === gmWatchedParentTabId){
        // Provisional candidate
        await chrome.storage.local.set({ gmSegmentResultsTabId: tab.id, gmSegmentResultsWhen: Date.now() });
      }
    }catch(_e){}
  });
  chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab)=>{
    try{
      if(changeInfo.url && /https:\/\/pro\.gedmatch\.com\/tools\/multi-kit-analysis\/segment-search/i.test(changeInfo.url)){
        await chrome.storage.local.set({ gmSegmentResultsTabId: tabId, gmSegmentResultsWhen: Date.now() });
      }
      if(tab && tab.url && /https:\/\/pro\.gedmatch\.com\/tools\/multi-kit-analysis\/segment-search/i.test(tab.url)){
        await chrome.storage.local.set({ gmSegmentResultsTabId: tabId, gmSegmentResultsWhen: Date.now() });
      }
    }catch(_e){}
  });
} catch(_e) {}
