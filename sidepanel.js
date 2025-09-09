/* global chrome */

function parseCsv(text) {
  const rows = [];
  let i = 0, field = '', row = [], inQuotes = false;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i+1] === '"') { field += '"'; i+=2; continue; } inQuotes = false; i++; continue; }
      field += c; i++; continue;
    } else {
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === ',') { row.push(field); field=''; i++; continue; }
      if (c === '\n' || c === '\r') { if (c==='\r'&&text[i+1]==='\n') i++; row.push(field); field=''; rows.push(row); row=[]; i++; continue; }
      field += c; i++; continue;
    }
  }
  if (field.length>0 || row.length>0) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1);
}

function normalizeHeaderRow(rows) {
  const headerIndex = rows.findIndex(r => r.some(c => /\bKit\b/i.test(c)) && r.some(c => /\bName\b/i.test(c)));
  if (headerIndex === -1) return { header: [], body: [] };
  return { header: rows[headerIndex], body: rows.slice(headerIndex+1) };
}

function toRecords(header, body) {
  const idx = Object.fromEntries(header.map((h,i)=>[h.trim(), i]));
  const get = (r,k)=>r[idx[k]] ?? '';
  return body.map(r=>({
    Kit: get(r,'Kit'),
    Name: get(r,'Name'),
    Email: get(r,'Email'),
    GedLink: get(r,'GED WikiTree'),
    Sex: get(r,'Sex'),
    Source: get(r,'Source'),
    Overlap: get(r,'Overlap')
  }));
}

function resolveGedUrl(s) {
  if (!s) return '';
  const t = String(s).trim();
  if (!t || t==='null') return '';
  if (/^https?:\/\//i.test(t)) return t;
  if (t.startsWith('/')) return `https://www.gedmatch.com${t}`;
  return `https://www.gedmatch.com/${t}`;
}

async function getState() {
  const s = await chrome.storage.local.get(['gmGedmatchSession','gmGedmatchPendingMeta','gmPendingCsvText','gmStatusByKit']);
  return {
    session: s.gmGedmatchSession || { profiles: [], queueIndex: 0, bundle: null },
    pendingMeta: s.gmGedmatchPendingMeta || null,
    pendingText: s.gmPendingCsvText || null,
    statusByKit: s.gmStatusByKit || {}
  };
}

async function saveSession(session) {
  await chrome.storage.local.set({ gmGedmatchSession: session });
}

async function saveStatusMap(statusByKit) {
  await chrome.storage.local.set({ gmStatusByKit: statusByKit });
}

function statusToClass(status) {
  if (status === 'green') return 'green';
  if (status === 'yellow') return 'yellow';
  return 'red';
}

function renderList(profiles, statusByKit) {
  const tbody = document.getElementById('rows');
  tbody.innerHTML = '';
  for (const p of profiles) {
    const st = statusToClass(statusByKit[p.Kit] || 'red');
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><span class="dot ${st}"></span></td><td>${p.Kit||''}</td><td>${p.Name||''}</td><td><button class="btn btn-link" data-kit="${p.Kit}">Open</button></td>`;
    tbody.appendChild(tr);
  }
  tbody.onclick = async (e) => {
    const btn = e.target.closest('button[data-kit]');
    if (!btn) return;
    const kit = btn.getAttribute('data-kit');
    const p = profiles.find(x => x.Kit === kit);
    if (p?.treeUrl) await chrome.tabs.create({ url: p.treeUrl, active: true });
  };
}

function updateStats(profiles, extra) {
  const total = profiles?.length || 0;
  const withLinks = (profiles || []).filter(p => p.treeUrl).length;
  const base = `${withLinks}/${total} with GED links`;
  document.getElementById('stats').textContent = extra ? `${base} • ${extra}` : base;
}

function buildSessionFromText(text) {
  const rows = parseCsv(text);
  const { header, body } = normalizeHeaderRow(rows);
  if (header.length === 0) return { error: 'Invalid CSV: header not found' };
  const recs = toRecords(header, body).map(r => ({ ...r, treeUrl: resolveGedUrl(r.GedLink) }));
  const profiles = recs.filter(r => !!r.treeUrl);
  return { session: { profiles, queueIndex: 0, bundle: { exportedAt: new Date().toISOString(), source: { site: 'GEDmatch' }, profiles, captures: [] } } };
}

(async function main(){
  const state = await getState();
  const fileInput = document.getElementById('csvFile');

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      await chrome.storage.local.set({ gmPendingCsvText: text, gmGedmatchPendingMeta: { name: file.name, size: file.size, lastModified: file.lastModified } });
      updateStats(state.session.profiles, `Pending: ${file.name}`);
    } catch (e) {
      updateStats(state.session.profiles, 'Failed to read file');
    }
  });

  document.getElementById('parseBtn').onclick = async () => {
    const s = await getState();
    if (!s.pendingText) { updateStats(s.session.profiles, 'No pending file'); return; }
    const built = buildSessionFromText(s.pendingText);
    if (built.error) { updateStats([], built.error); return; }
    await saveSession(built.session);
    // Initialize status map entries for new profiles as red if not present
    const statusByKit = (await getState()).statusByKit;
    for (const p of built.session.profiles) {
      if (!statusByKit[p.Kit]) statusByKit[p.Kit] = 'red';
    }
    await saveStatusMap(statusByKit);
    renderList(built.session.profiles, statusByKit);
    updateStats(built.session.profiles, s.pendingMeta?.name ? `Loaded: ${s.pendingMeta.name}` : undefined);
    chrome.storage.local.remove(['gmPendingCsvText','gmGedmatchPendingMeta']);
  };

  document.getElementById('openNext').onclick = async () => {
    const s = (await getState()).session;
    if (!s.profiles?.length) return;
    const i = Math.max(0, Math.min(s.queueIndex || 0, s.profiles.length - 1));
    const p = s.profiles[i];
    s.queueIndex = i + 1;
    await saveSession(s);
    if (p?.treeUrl) await chrome.tabs.create({ url: p.treeUrl, active: true });
  };

  document.getElementById('exportJson').onclick = async () => {
    const s = (await getState()).session;
    const blob = new Blob([JSON.stringify(s.bundle || {}, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const filename = `gedmatch-import-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    await chrome.downloads.download({ url, filename, saveAs: true });
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  // Initial render
  const st = await getState();
  if (st.session.profiles?.length) {
    renderList(st.session.profiles, st.statusByKit);
    updateStats(st.session.profiles, st.pendingMeta?.name ? `Last: ${st.pendingMeta.name}` : undefined);
  } else if (st.pendingMeta?.name) {
    updateStats([], `Pending: ${st.pendingMeta.name}`);
  } else {
    updateStats([]);
  }
})();
