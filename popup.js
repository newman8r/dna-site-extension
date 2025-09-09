/* global chrome */

// Basic CSV parser tolerant of quoted newlines
function parseCsv(text) {
  const rows = [];
  let i = 0, field = '', row = [], inQuotes = false;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    } else {
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === ',') { row.push(field); field = ''; i++; continue; }
      if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        rows.push(row);
        row = []; i++; continue;
      }
      field += c; i++; continue;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1);
}

function normalizeHeaderRow(rows) {
  const headerIndex = rows.findIndex(r => r.some(c => /\bKit\b/i.test(c)) && r.some(c => /\bName\b/i.test(c)));
  if (headerIndex === -1) return { header: [], body: [] };
  const header = rows[headerIndex];
  const body = rows.slice(headerIndex + 1);
  return { header, body };
}

function toRecords(header, body) {
  const idx = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
  const get = (r, k) => r[idx[k]] ?? '';
  const recs = body.map(r => ({
    Kit: get(r, 'Kit'),
    Name: get(r, 'Name'),
    Email: get(r, 'Email'),
    GedLink: get(r, 'GED WikiTree'),
    Sex: get(r, 'Sex'),
    Source: get(r, 'Source'),
    Overlap: get(r, 'Overlap')
  }));
  return recs;
}

function resolveGedUrl(pathish) {
  if (!pathish) return '';
  const trimmed = String(pathish).trim();
  if (!trimmed || trimmed === 'null') return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('/')) return `https://www.gedmatch.com${trimmed}`;
  return `https://www.gedmatch.com/${trimmed}`;
}

async function saveSession(session) {
  await chrome.storage.local.set({ gmGedmatchSession: session });
  console.log('[GM-Popup] saved session', session?.profiles?.length || 0);
}

async function loadState() {
  const s = await chrome.storage.local.get(['gmGedmatchSession', 'gmGedmatchPendingMeta', 'gmPendingCsvText']);
  return {
    session: s.gmGedmatchSession || { profiles: [], queueIndex: 0, bundle: null },
    pendingMeta: s.gmGedmatchPendingMeta || null,
    pendingText: s.gmPendingCsvText || null
  };
}

function renderList(profiles) {
  const tbody = document.getElementById('rows');
  tbody.innerHTML = '';
  for (const p of profiles) {
    const tr = document.createElement('tr');
    const openBtn = `<button class="btn btn-link" data-kit="${p.Kit}">Open</button>`;
    tr.innerHTML = `<td>${p.Kit || ''}</td><td>${p.Name || ''}</td><td>${p.treeUrl ? 'Yes' : ''}</td><td>${openBtn}</td>`;
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

async function main() {
  const state = await loadState();
  const fileInput = document.getElementById('csvFile');

  // On file select: send the File to background to persist text, but DO NOT parse yet
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    console.log('[GM-Popup] sending file to background');
    chrome.runtime.sendMessage({ type: 'gm:receiveFile', name: file.name, size: file.size, lastModified: file.lastModified, blob: file }, (resp) => {
      if (chrome.runtime.lastError) {
        console.warn('[GM-Popup] receiveFile error', chrome.runtime.lastError.message);
      }
      if (resp?.ok) {
        updateStats(state.session.profiles, `Pending: ${file.name}`);
      } else {
        updateStats(state.session.profiles, `Failed to store file`);
      }
    });
  });

  document.getElementById('parseBtn').addEventListener('click', async () => {
    const { pendingText, pendingMeta } = await loadState();
    if (!pendingText) { updateStats(state.session.profiles, 'No pending file'); return; }
    const built = buildSessionFromText(pendingText);
    if (built.error) { updateStats([], built.error); return; }
    await saveSession(built.session);
    renderList(built.session.profiles);
    updateStats(built.session.profiles, pendingMeta?.name ? `Loaded: ${pendingMeta.name}` : undefined);
    chrome.runtime.sendMessage({ type: 'gm:clearPending' }, () => {});
  });

  document.getElementById('openNext').addEventListener('click', async () => {
    const s = (await loadState()).session;
    if (!s.profiles?.length) return;
    const i = Math.max(0, Math.min(s.queueIndex || 0, s.profiles.length - 1));
    const p = s.profiles[i];
    s.queueIndex = i + 1;
    await saveSession(s);
    if (p?.treeUrl) await chrome.tabs.create({ url: p.treeUrl, active: true });
  });

  document.getElementById('exportJson').addEventListener('click', async () => {
    const s = (await loadState()).session;
    const blob = new Blob([JSON.stringify(s.bundle || {}, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const filename = `gedmatch-import-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    await chrome.downloads.download({ url, filename, saveAs: true });
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  });

  // Restore UI on open
  if (state.session.profiles?.length) {
    renderList(state.session.profiles);
    updateStats(state.session.profiles, state.pendingMeta?.name ? `Last: ${state.pendingMeta.name}` : undefined);
  } else if (state.pendingMeta?.name) {
    updateStats([], `Pending: ${state.pendingMeta.name}`);
  } else {
    updateStats([]);
  }

  // Keep-alive
  try {
    const port = chrome.runtime.connect({ name: 'gm-keepalive' });
    setInterval(() => { try { port.postMessage({ t: Date.now() }); } catch {} }, 2000);
  } catch {}
}

main().catch(err => console.error('[GM-Popup] fatal', err));
