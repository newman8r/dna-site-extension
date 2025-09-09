/* global chrome */
(function() {
  const logEl = document.getElementById('log');
  const log = (...args) => { console.log('[GM-IMPORT]', ...args); logEl.textContent = args.join(' '); };

  function parseCsv(text) {
    const rows = [];
    let i = 0, field = '', row = [], inQuotes = false;
    while (i < text.length) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') { if (text[i+1] === '"') { field += '"'; i += 2; continue; } inQuotes = false; i++; continue; }
        field += c; i++; continue;
      } else {
        if (c === '"') { inQuotes = true; i++; continue; }
        if (c === ',') { row.push(field); field = ''; i++; continue; }
        if (c === '\n' || c === '\r') { if (c === '\r' && text[i+1] === '\n') i++; row.push(field); field=''; rows.push(row); row=[]; i++; continue; }
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
    if (!t || t === 'null') return '';
    if (/^https?:\/\//i.test(t)) return t;
    if (t.startsWith('/')) return `https://www.gedmatch.com${t}`;
    return `https://www.gedmatch.com/${t}`;
  }

  async function getStore() {
    return await chrome.storage.local.get(['gmGedmatchSession','gmGedmatchPendingFile']);
  }

  async function setStore(obj) {
    await chrome.storage.local.set(obj);
  }

  function renderList(profiles) {
    const tbody = document.getElementById('rows');
    tbody.innerHTML = '';
    for (const p of profiles) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${p.Kit||''}</td><td>${p.Name||''}</td><td>${p.treeUrl?'Yes':''}</td><td><button class="btn btn-link" data-kit="${p.Kit}">Open</button></td>`;
      tbody.appendChild(tr);
    }
    tbody.onclick = async (e) => {
      const btn = e.target.closest('button[data-kit]');
      if (!btn) return;
      const kit = btn.getAttribute('data-kit');
      const p = profiles.find(x => x.Kit === kit);
      if (p?.treeUrl) {
        await chrome.tabs.create({ url: p.treeUrl, active: true });
      }
    };
  }

  function updateStats(profiles, extra) {
    const total = profiles?.length || 0;
    const withLinks = (profiles || []).filter(p => p.treeUrl).length;
    const base = `${withLinks}/${total} with GED links`;
    document.getElementById('stats').textContent = extra ? `${base} • ${extra}` : base;
  }

  function parseToSession(text, session) {
    const rows = parseCsv(text);
    const { header, body } = normalizeHeaderRow(rows);
    if (header.length === 0) { updateStats([], 'Invalid CSV'); return; }
    const recs = toRecords(header, body).map(r => ({ ...r, treeUrl: resolveGedUrl(r.GedLink) }));
    const profiles = recs.filter(r => !!r.treeUrl);
    session.profiles = profiles;
    session.queueIndex = 0;
    session.bundle = { exportedAt: new Date().toISOString(), source: { site: 'GEDmatch' }, profiles, captures: [] };
    renderList(profiles);
    updateStats(profiles);
  }

  async function main() {
    const store = await getStore();
    const session = store.gmGedmatchSession || { profiles: [], queueIndex: 0, bundle: null };
    const pending = store.gmGedmatchPendingFile || null;

    const fileInput = document.getElementById('csvFile');
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      if (!file) return;
      const text = await file.text();
      await setStore({ gmGedmatchPendingFile: { name: file.name, lastModified: file.lastModified, size: file.size, text } });
      log('Stored file', file.name, file.size);
      updateStats(session.profiles, `Pending: ${file.name}`);
    });

    document.getElementById('parseBtn').onclick = async () => {
      const f = fileInput.files[0];
      let text = f ? await f.text() : (pending?.text || null);
      if (!text) { updateStats(session.profiles, 'No file selected'); return; }
      parseToSession(text, session);
      await setStore({ gmGedmatchSession: session });
      log('Parsed rows:', session.profiles.length);
    };

    document.getElementById('openNext').onclick = async () => {
      if (!session.profiles?.length) return;
      const i = Math.max(0, Math.min(session.queueIndex || 0, session.profiles.length - 1));
      const p = session.profiles[i];
      session.queueIndex = i + 1;
      await setStore({ gmGedmatchSession: session });
      if (p?.treeUrl) await chrome.tabs.create({ url: p.treeUrl, active: true });
    };

    document.getElementById('exportJson').onclick = async () => {
      const s = (await getStore()).gmGedmatchSession || session;
      const blob = new Blob([JSON.stringify(s.bundle || {}, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const filename = `gedmatch-import-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      await chrome.downloads.download({ url, filename, saveAs: true });
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    };

    if (session.profiles?.length) {
      renderList(session.profiles);
      updateStats(session.profiles, pending?.name ? `Pending: ${pending.name}` : undefined);
    } else if (pending?.name) {
      updateStats([], `Pending: ${pending.name}`);
    } else {
      updateStats([]);
    }
  }

  main().catch(err => { console.error(err); log('Error', err?.message || err); });
})();
