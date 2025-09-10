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
  if (!t || t === 'null') return '';
  if (/^https?:\/\//i.test(t)) {
    try { const u = new URL(t); if (/\.gedmatch\.com$/i.test(u.hostname) && u.hostname !== 'pro.gedmatch.com') { u.hostname = 'pro.gedmatch.com'; return u.toString(); } return t; } catch {}
  }
  if (t.startsWith('/')) return `https://pro.gedmatch.com${t}`;
  return `https://pro.gedmatch.com/${t}`;
}

async function getState() {
  const s = await chrome.storage.local.get(['gmGedmatchSession','gmGedmatchPendingMeta','gmPendingCsvText','gmStatusByKit','gmFocusedKit','gmCapturedByKit','gmLogsByKit']);
  return {
    session: s.gmGedmatchSession || { profiles: [], queueIndex: 0, bundle: null },
    pendingMeta: s.gmGedmatchPendingMeta || null,
    pendingText: s.gmPendingCsvText || null,
    statusByKit: s.gmStatusByKit || {},
    focusedKit: s.gmFocusedKit || null,
    capturedByKit: s.gmCapturedByKit || {},
    logsByKit: s.gmLogsByKit || {}
  };
}

async function saveSession(session) { await chrome.storage.local.set({ gmGedmatchSession: session }); }
async function saveStatusMap(statusByKit) { await chrome.storage.local.set({ gmStatusByKit: statusByKit }); }
async function setFocusedKit(kit) { await chrome.storage.local.set({ gmFocusedKit: kit }); }
async function saveCapture(kit, capture, logs) {
  const s = await chrome.storage.local.get(['gmCapturedByKit','gmLogsByKit']);
  const cap = s.gmCapturedByKit || {}; const lg = s.gmLogsByKit || {};
  cap[kit] = capture; lg[kit] = logs || [];
  await chrome.storage.local.set({ gmCapturedByKit: cap, gmLogsByKit: lg });
}

function statusToClass(status) { return status === 'green' ? 'green' : status === 'yellow' ? 'yellow' : 'red'; }

function setCurrentBox(profile, status) {
  const box = document.getElementById('currentBox');
  if (!profile) { box.classList.add('hidden'); return; }
  document.getElementById('currentName').textContent = profile.Name || '—';
  document.getElementById('currentKit').textContent = profile.Kit || '—';
  document.getElementById('currentEmail').textContent = profile.Email || '';
  const dot = document.getElementById('currentDot');
  dot.classList.remove('red','yellow','green');
  dot.classList.add(statusToClass(status || 'red'));
  box.classList.remove('hidden');
}

function renderList(profiles, statusByKit) {
  const tbody = document.getElementById('rows');
  tbody.innerHTML = '';
  for (const p of profiles) {
    const st = statusToClass(statusByKit[p.Kit] || 'red');
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><span class=\"dot ${st}\"></span></td><td>${p.Kit||''}</td><td>${p.Name||''}</td><td><button class=\"btn btn-link\" data-kit=\"${p.Kit}\">Open</button></td>`;
    tbody.appendChild(tr);
  }
  tbody.onclick = async (e) => {
    const btn = e.target.closest('button[data-kit]');
    if (!btn) return;
    const kit = btn.getAttribute('data-kit');
    const p = profiles.find(x => x.Kit === kit);
    if (!p) return;
    setCurrentBox(p, statusByKit[kit] || 'red');
    await setFocusedKit(kit);
    if (p.treeUrl) await chrome.tabs.create({ url: p.treeUrl, active: true });
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

const MONTHS = { jan:'JAN', feb:'FEB', mar:'MAR', apr:'APR', may:'MAY', jun:'JUN', jul:'JUL', aug:'AUG', sep:'SEP', sept:'SEP', oct:'OCT', nov:'NOV', dec:'DEC' };
function normalizeDate(s) { if (!s) return null; const t = s.trim().replace(/\.$/, ''); const abt=t.match(/^abt\.?\s*(\d{4})/i); if (abt) return `ABT ${abt[1]}`; const dmY=t.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/); if (dmY){ const m=MONTHS[dmY[2].toLowerCase()]; if (m) return `${dmY[1]} ${m} ${dmY[3]}`;} const mY=t.match(/^([A-Za-z]{3,})\s+(\d{4})$/); if(mY){const m=MONTHS[mY[1].toLowerCase()]; if(m) return `${m} ${mY[2]}`;} const y=t.match(/(\d{4})/); if(y) return y[1]; return null; }
function splitDatePlace(s){ if(!s) return {date:null,place:null}; const idx=s.indexOf(','); if(idx===-1) return {date:normalizeDate(s),place:null}; const datePart=s.slice(0,idx).trim(); const placePart=s.slice(idx+1).trim(); return {date:normalizeDate(datePart), place: placePart||null}; }
function parsePersonLabel(label){ let name=label.trim(); let birthStr=null, deathStr=null; const bi=name.toLowerCase().indexOf(' b.'); const di=name.toLowerCase().indexOf(' d.'); if(bi!==-1 && (di===-1||bi<di)){ const rest=name.slice(bi+3).trim(); name=name.slice(0,bi).trim().replace(/,$/,''); if(rest.toLowerCase().includes(', d.')){ const di2=rest.toLowerCase().indexOf(', d.'); birthStr=rest.slice(0,di2).trim(); deathStr=rest.slice(di2+4).trim(); } else { birthStr=rest; } } else if (di!==-1){ deathStr=name.slice(di+4).trim(); name=name.slice(0,di).trim().replace(/,$/,''); } const b=splitDatePlace(birthStr); const d=splitDatePlace(deathStr); return { name, birth: b, death: d }; }

async function extractPreFromActiveTab(){
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true}); if(!tab?.id) throw new Error('No active tab');
  const [{result}={}] = await chrome.scripting.executeScript({ target:{tabId:tab.id}, func:()=>{ const pre=document.querySelector('section.response-items pre')||document.querySelector('pre'); if(!pre) return {ok:false,error:'pre not found'}; const rect=pre.getBoundingClientRect(); const anchors=Array.from(pre.querySelectorAll('a')).map(a=>{ const r=a.getBoundingClientRect(); const font=a.querySelector('font'); const color=(font?.getAttribute('color')||'').toLowerCase(); return { label:(a.textContent||'').trim(), href:a.getAttribute('href')||a.href||'', color, x: Math.round(r.left-rect.left), y: Math.round(r.top-rect.top) }; }); return {ok:true, html: pre.innerHTML, text: pre.innerText, anchors}; }});
  if(!result?.ok) throw new Error(result?.error||'extract failed'); return result; }

function clusterRows(anchors){ const sorted=[...anchors].sort((a,b)=>a.y-b.y); const rows=[]; const ys=[]; for(const a of sorted){ if(!ys.length || Math.abs(a.y-ys[ys.length-1])>14){ ys.push(a.y); rows.push([a]); } else { rows[rows.length-1].push(a); } } return rows; }

function parseIndividualsFromPre(result){
  const logs=[];
  const text = (result.text || '').replace(/\u00a0/g, ' ');
  const lines = text.split(/\r?\n/);
  
  // Collect anchors with sex/color and href
  let anchors = [];
  if (Array.isArray(result.anchors) && result.anchors.length) {
    anchors = result.anchors.map(a => ({ label: (a.label||'').trim(), href: a.href||'', color: (a.color||'').toLowerCase() }));
  } else {
    const container=document.createElement('div'); container.innerHTML=result.html||'';
    anchors = Array.from(container.querySelectorAll('a')).map(a=>{ const font=a.querySelector('font'); return { label:(a.textContent||'').trim(), href:a.getAttribute('href')||'', color:(font?.getAttribute('color')||'').toLowerCase() }; });
  }
  
  // Build people list with line positions
  const people = [];
  const lineData = []; // {lineIdx, type:'person'|'slash', personId?, slashes?}
  
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    
    // Check if this line has a person
    let personOnLine = null;
    for (let anchorIdx = 0; anchorIdx < anchors.length; anchorIdx++) {
      const anchor = anchors[anchorIdx];
      if (line.includes(anchor.label)) {
        const col = line.indexOf(anchor.label);
        const sex = anchor.color === 'red' ? 'F' : anchor.color === 'blue' ? 'M' : 'U';
        const url = resolveGedUrl(anchor.href || '');
        const parsed = parsePersonLabel(anchor.label);
        
        const personId = people.length;
        people.push({
          id: personId,
          sex: sex,
          url: url,
          name: parsed.name,
          birth: parsed.birth,
          death: parsed.death,
          line: lineIdx,
          col: col,
          indent: col  // Use column as indent level
        });
        
        personOnLine = personId;
        logs.push(`Person ${personId}: ${parsed.name} at line ${lineIdx}, col ${col}`);
        break;
      }
    }
    
    if (personOnLine !== null) {
      lineData.push({ lineIdx, type: 'person', personId: personOnLine });
    } else {
      // Check for slashes
      const slashes = [];
      for (let c = 0; c < line.length; c++) {
        if (line[c] === '/') slashes.push({type: '/', col: c});
        else if (line[c] === '\\') slashes.push({type: '\\', col: c});
      }
      if (slashes.length > 0) {
        lineData.push({ lineIdx, type: 'slash', slashes });
      }
    }
  }
  
  // Find the starting individual (least indented)
  let startPerson = null;
  let minIndent = Infinity;
  for (const p of people) {
    if (p.indent < minIndent) {
      minIndent = p.indent;
      startPerson = p;
    }
  }
  logs.push(`Starting individual: ${startPerson?.name} at indent ${minIndent}`);
  
  // Build families using stack-based algorithm
  const families = [];
  const familyMap = new Map(); // key: "parent1Id,parent2Id" -> family object
  
  // Process from bottom to top (reverse order)
  for (let i = lineData.length - 1; i >= 0; i--) {
    const current = lineData[i];
    
    if (current.type === 'person') {
      const person = people[current.personId];
      
      // Look for slash line above (person is a child)
      if (i > 0 && lineData[i-1].type === 'slash') {
        const slashLine = lineData[i-1];
        
        // Find / and \ pair closest to person's position
        let bestSlash = null, bestBackslash = null;
        let minDistance = Infinity;
        
        for (const s of slashLine.slashes) {
          if (s.type === '/') {
            // Find matching backslash to the right
            for (const bs of slashLine.slashes) {
              if (bs.type === '\\' && bs.col > s.col) {
                const midpoint = (s.col + bs.col) / 2;
                const distance = Math.abs(person.col - midpoint);
                if (distance < minDistance) {
                  minDistance = distance;
                  bestSlash = s;
                  bestBackslash = bs;
                }
              }
            }
          }
        }
        
        if (bestSlash && bestBackslash) {
          // Find parents above the slash positions
          const parents = [];
          
          // Left parent: look above the / position
          for (let j = i - 2; j >= 0; j--) {
            if (lineData[j].type === 'person') {
              const parent = people[lineData[j].personId];
              if (Math.abs(parent.col - bestSlash.col) < 20) {
                parents.push(lineData[j].personId);
                break;
              }
            }
          }
          
          // Right parent: look for person near backslash
          // First check if there's a person on the same line as child but to the right
          for (const p of people) {
            if (p.line === person.line && p.col > person.col && p.col - person.col < 100) {
              // This is likely the spouse on the same line
              if (Math.abs(p.col - bestBackslash.col) < 50) {
                parents.push(p.id);
                break;
              }
            }
          }
          
          // If no right parent found, look above the backslash
          if (parents.length === 1) {
            for (let j = i - 2; j >= 0; j--) {
              if (lineData[j].type === 'person') {
                const parent = people[lineData[j].personId];
                if (Math.abs(parent.col - bestBackslash.col) < 20) {
                  parents.push(lineData[j].personId);
                  break;
                }
              }
            }
          }
          
          // Create or update family
          if (parents.length > 0) {
            const famKey = parents.slice().sort((a,b) => a-b).join(',');
            if (!familyMap.has(famKey)) {
              familyMap.set(famKey, {
                parents: parents.slice(0, 2),
                children: []
              });
            }
            const family = familyMap.get(famKey);
            if (!family.children.includes(person.id)) {
              family.children.push(person.id);
            }
            logs.push(`Family created: parents ${parents.join(',')} -> child ${person.id}`);
          }
        }
      }
      
      // Look for slash line below (person is a parent)
      if (i < lineData.length - 1 && lineData[i+1].type === 'slash') {
        const slashLine = lineData[i+1];
        
        // Find / and \ pair near person's position
        let bestSlash = null, bestBackslash = null;
        
        for (const s of slashLine.slashes) {
          if (s.type === '/' && Math.abs(s.col - person.col) < 30) {
            // Find matching backslash to the right
            for (const bs of slashLine.slashes) {
              if (bs.type === '\\' && bs.col > s.col) {
                bestSlash = s;
                bestBackslash = bs;
                break;
              }
            }
            if (bestSlash) break;
          }
        }
        
        if (bestSlash && bestBackslash) {
          // Find child below the midpoint
          const midpoint = Math.floor((bestSlash.col + bestBackslash.col) / 2);
          let childId = null;
          
          for (let j = i + 2; j < lineData.length && j <= i + 10; j++) {
            if (lineData[j].type === 'person') {
              const child = people[lineData[j].personId];
              if (Math.abs(child.col - midpoint) < 20) {
                childId = lineData[j].personId;
                break;
              }
            }
          }
          
          if (childId !== null) {
            // Find spouse (other parent)
            let spouseId = null;
            
            // Check for person near the backslash position
            for (const p of people) {
              if (p.id !== person.id && Math.abs(p.line - person.line) <= 1) {
                if (Math.abs(p.col - bestBackslash.col) < 30 && p.col > person.col) {
                  spouseId = p.id;
                  break;
                }
              }
            }
            
            // Create family
            const parents = spouseId !== null ? [person.id, spouseId].sort((a,b) => a-b) : [person.id];
            const famKey = parents.join(',');
            
            if (!familyMap.has(famKey)) {
              familyMap.set(famKey, {
                parents: parents,
                children: []
              });
            }
            const family = familyMap.get(famKey);
            if (!family.children.includes(childId)) {
              family.children.push(childId);
            }
            logs.push(`Family created: parents ${parents.join(',')} -> child ${childId}`);
          }
        }
      }
    }
  }
  
  // Convert map to array
  for (const family of familyMap.values()) {
    families.push(family);
  }
  
  return { people, families, logs };
}

// Build intermediary JSON: one entry per row with tokens and detected persons
function buildIntermediaryRows(result){
  const text=(result.text||'').replace(/\u00a0/g,' ');
  const lines=text.split(/\r?\n/);
  let anchors=[];
  if(Array.isArray(result.anchors)&&result.anchors.length){ anchors=result.anchors.map(a=>({ label:(a.label||'').trim(), href:a.href||'', color:(a.color||'').toLowerCase() })); }
  else { const container=document.createElement('div'); container.innerHTML=result.html||''; anchors=Array.from(container.querySelectorAll('a')).map(a=>{ const font=a.querySelector('font'); return { label:(a.textContent||'').trim(), href:a.getAttribute('href')||'', color:(font?.getAttribute('color')||'').toLowerCase() }; }); }

  function pairOutermost(lefts, rights){ const segs=[]; let li=0; let ri=rights.length-1; while(li<lefts.length && ri>=0){ const l=lefts[li]; while(ri>=0 && rights[ri]<=l) ri--; if(ri<0) break; const r=rights[ri--]; if(r>l) segs.push({ L:l, R:r, mid: Math.floor((l+r)/2) }); li++; } return segs; }

  const rows=[]; let personLines=0; let charLines=0;
  for(let i=0;i<lines.length;i++){
    const s=lines[i];
    // pipe scan for every row (both person and char rows can have pipes)
    const rowPipes=[]; for(let c=0;c<s.length;c++){ if(s[c]==='|') rowPipes.push(c); }
    // detect persons from anchors on this line
    const persons=[]; for(const a of anchors){ if(!a.label) continue; const idx=s.indexOf(a.label); if(idx!==-1){ const parsed=parsePersonLabel(a.label); const sex=a.color==='red'?'F':a.color==='blue'?'M':'U'; const url=resolveGedUrl(a.href||''); const leadingSpaces=(s.match(/^\s*/)||[''])[0].length; const indent=Math.floor(leadingSpaces/2); persons.push({ label:a.label, name:parsed.name, birth:parsed.birth, death:parsed.death, sex, url, col:idx, indent, leadingSpaces }); } }
    if(persons.length){
      rows.push({ idx:i, type:'person', persons, text:s, pipes: rowPipes, pipeCount: rowPipes.length }); personLines++; continue;
    }
    // char row tokens
    const pipes=[]; const lefts=[]; const rights=[]; for(let c=0;c<s.length;c++){ const ch=s[c]; if(ch==='|') pipes.push(c); else if(ch==='/') lefts.push(c); else if(ch==='\\') rights.push(c); }
    const segments=pairOutermost(lefts, rights);
    rows.push({ idx:i, type:'char', pipes, pipeCount: pipes.length, lefts, rights, segments, text:s }); charLines++;
  }
  return { totalLines: lines.length, personLines, charLines, rows };
}

// Pipe-reduction algorithm - processes from most pipes to least
function parseIndividualsFromPreV2(result){
  const logs=[];
  const text = (result.text || '').replace(/\u00a0/g, ' ');
  const lines = text.split(/\r?\n/);

  // Collect anchors with sex/color and href
  let anchors = [];
  if (Array.isArray(result.anchors) && result.anchors.length) {
    anchors = result.anchors.map(a => ({ label: (a.label||'').trim(), href: a.href||'', color: (a.color||'').toLowerCase() }));
  } else {
    const container=document.createElement('div'); container.innerHTML=result.html||'';
    anchors = Array.from(container.querySelectorAll('a')).map(a=>{ const font=a.querySelector('font'); return { label:(a.textContent||'').trim(), href:a.getAttribute('href')||'', color:(font?.getAttribute('color')||'').toLowerCase() }; });
  }

  // Index people by scanning for labels on their lines
  const people=[];
  const linePeople=new Map(); // line -> [{id,col}]
  for(let i=0;i<lines.length;i++){
    const s=lines[i];
    for(const a of anchors){
      const idx=s.indexOf(a.label);
      if(idx!==-1){
        const sex=a.color==='red'?'F':a.color==='blue'?'M':'U';
        const url=resolveGedUrl(a.href||'');
        const parsed=parsePersonLabel(a.label);
        const id=people.length;
        people.push({ id, sex, url, name: parsed.name, birth: parsed.birth, death: parsed.death, line:i, col:idx, indent:idx });
        if(!linePeople.has(i)) linePeople.set(i, []);
        linePeople.get(i).push({ id, col: idx });
      }
    }
    if(linePeople.has(i)) linePeople.get(i).sort((a,b)=>a.col-b.col);
  }

  // Precompute per-row tokenization
  const rows = lines.map((s, i) => {
    const pipes = new Set();
    const lslashes=[]; const rslashes=[];
    for(let c=0;c<s.length;c++){
      const ch=s[c];
      if(ch==='|') pipes.add(c);
      else if(ch==='/' ) lslashes.push(c);
      else if(ch==='\\') rslashes.push(c);
    }
    return { i, text:s, pipes, lslashes, rslashes, segments:[], persons: (linePeople.get(i)||[]) };
  });

  // Helper: build segments per row (greedy left->right)
  function buildSegments(i){
    const row=rows[i]; if(!row) return; if(!row.lslashes.length || !row.rslashes.length) return;
    const lefts=row.lslashes.slice(); const rights=row.rslashes.slice();
    let rIdx=0;
    for(const l of lefts){
      while(rIdx<rights.length && rights[rIdx]<=l) rIdx++;
      if(rIdx>=rights.length) break; const r=rights[rIdx++];
      // ensure no other '/' between l and r (basic non-overlap)
      let hasInnerLeft=false; for(const l2 of lefts){ if(l2>l && l2<r){ hasInnerLeft=true; break; } }
      if(hasInnerLeft) continue;
      const mid=Math.floor((l+r)/2);
      row.segments.push({ l, r, mid });
    }
  }
  for(let i=0;i<rows.length;i++) buildSegments(i);
  logs.push({ type:'token-rows', items: rows.map(r=>({ row:r.i, pipes:[...r.pipes], lefts:r.lslashes, rights:r.rslashes, persons:r.persons })) });
  logs.push({ type:'segments-per-row', items: rows.filter(r=>r.segments.length).map(r=>({ row:r.i, segs:r.segments })) });

  function rowHasPipeOrSpan(i, col){
    const row=rows[i]; if(!row) return false;
    if(row.pipes.has(col)) return true;
    for(const seg of row.segments){ if(seg.l<col && col<seg.r) return true; }
    return false;
  }

  function findNearestPersonOnLine(i, col, tol){
    const list=linePeople.get(i)||[]; let best=null, bestd=1e9;
    for(const p of list){ const d=Math.abs(p.col-col); if(d<=tol && d<bestd){ best=p; bestd=d; } }
    return best?best.id:null;
  }

  // PASS 1: Resolve each segment into a family via pipe tracing
  const familyMap=new Map();
  const childTaken=new Map(); // childId -> {byRow, mid}
  const K=3; // require pipe within next K rows
  const tolSlash=10; const tolChild=8; const tolSpouse=8;

  for(const row of rows){
    if(!row.segments.length) continue;
    for(const seg of row.segments){
      const mid=seg.mid; const lcol=seg.l; const rcol=seg.r;
      // Validate pipe presence shortly below
      let pipeOk=false; const pipeTrace=[];
      for(let k=1;k<=K && row.i+k<rows.length;k++){
        if(rowHasPipeOrSpan(row.i+k, mid)){ pipeOk=true; pipeTrace.push(row.i+k); break; }
      }
      if(!pipeOk){ logs.push({ type:'segment-reject-no-pipe', row:row.i, seg }); continue; }

      // Trace downward to find spouse then child
      let spouseId=null; let childId=null; const trace=[...pipeTrace];
      let t=row.i+1; let steps=0; const maxSteps=20;
      while(t<rows.length && steps++<maxSteps){
        const cont=rowHasPipeOrSpan(t, mid);
        if(cont) trace.push(t);
        if(rows[t].persons.length){
          const person=rows[t].persons[0];
          const pcol=person.col;
          if(spouseId==null && pcol>mid+tolSpouse){ spouseId=person.id; }
          else if(Math.abs(pcol-mid)<=tolChild){ childId=person.id; break; }
        }
        if(!cont && rows[t].persons.length){
          const person=rows[t].persons[0]; if(Math.abs(person.col-mid)<=tolChild){ childId=person.id; break; }
        }
        // Do NOT break early; allow sparse rows (single slash or empty) between spouse and child
        t++;
      }

      // Left parent upwards near '/'
      let leftParentId=null; for(let u=row.i-1; u>=0 && row.i-u<=8; u--){ const pid=findNearestPersonOnLine(u, lcol, tolSlash); if(pid!=null){ leftParentId=pid; break; } }

      // If spouse missing, try upwards near '\\'
      if(spouseId==null){ for(let u=row.i-1; u>=0 && row.i-u<=6; u--){ const pid=findNearestPersonOnLine(u, rcol, tolSlash); if(pid!=null){ spouseId=pid; break; } } }

      logs.push({ type:'segment-eval', row:row.i, seg:{...seg}, mid, pipeTrace:trace, leftParentId, spouseId, childId });

      if(childId==null){ continue; }
      const taken=childTaken.get(childId);
      if(taken){
        const childCol=(people.find(p=>p.id===childId)||{}).col||mid;
        const prevDist=Math.abs(childCol - taken.mid);
        const newDist=Math.abs(childCol - mid);
        if(newDist>=prevDist){ logs.push({ type:'conflict-child-skip', childId, prev:taken, candidate:{ row:row.i, mid } }); continue; }
        else { logs.push({ type:'conflict-child-replace', childId, prev:taken, candidate:{ row:row.i, mid } }); }
      }
      childTaken.set(childId, { byRow: row.i, mid });

      const parents=[]; if(leftParentId!=null) parents.push(leftParentId); if(spouseId!=null && spouseId!==leftParentId) parents.push(spouseId);
      if(!parents.length){ logs.push({ type:'segment-no-parents', row:row.i, childId }); continue; }
      const key=parents.slice().sort((a,b)=>a-b).join('|');
      if(!familyMap.has(key)) familyMap.set(key, { parents: parents.slice(0,2), children: [] });
      const fam=familyMap.get(key);
      if(!fam.children.includes(childId)) fam.children.push(childId);
    }
  }

  const families=[...familyMap.values()];
  return { people, families, logs };
}

// V3 Parser - Pipe tracking and reduction algorithm
function parseIndividualsFromPreV3(result){
  const logs=[];
  const text = (result.text || '').replace(/\u00a0/g, ' ');
  const lines = text.split(/\r?\n/);

  // Collect anchors with sex/color and href
  let anchors = [];
  if (Array.isArray(result.anchors) && result.anchors.length) {
    anchors = result.anchors.map(a => ({ label: (a.label||'').trim(), href: a.href||'', color: (a.color||'').toLowerCase() }));
  } else {
    const container=document.createElement('div'); container.innerHTML=result.html||'';
    anchors = Array.from(container.querySelectorAll('a')).map(a=>{ const font=a.querySelector('font'); return { label:(a.textContent||'').trim(), href:a.getAttribute('href')||'', color:(font?.getAttribute('color')||'').toLowerCase() }; });
  }

  // Index people by scanning for labels on their lines
  const people=[];
  const linePeople=new Map(); // line -> [{id,col}]
  for(let i=0;i<lines.length;i++){
    const s=lines[i];
    for(const a of anchors){
      const idx=s.indexOf(a.label);
      if(idx!==-1){
        const sex=a.color==='red'?'F':a.color==='blue'?'M':'U';
        const url=resolveGedUrl(a.href||'');
        const parsed=parsePersonLabel(a.label);
        const id=people.length;
        people.push({ id, sex, url, name: parsed.name, birth: parsed.birth, death: parsed.death, line:i, col:idx, indent:idx });
        if(!linePeople.has(i)) linePeople.set(i, []);
        linePeople.get(i).push({ id, col: idx });
      }
    }
    if(linePeople.has(i)) linePeople.get(i).sort((a,b)=>a.col-b.col);
  }

  // Build structured rows
  const rows = lines.map((s, i) => {
    const chars = s.split('');
    const pipes = [];
    const slashes = [];
    for(let c=0;c<chars.length;c++){
      if(chars[c]==='|') pipes.push(c);
      else if(chars[c]==='/') slashes.push({type:'/', col:c});
      else if(chars[c]==='\\') slashes.push({type:'\\', col:c});
    }
    const persons = linePeople.get(i) || [];
    return { i, text:s, pipes, slashes, persons };
  });

  // Track pipe continuity through the tree
  const pipeTracker = new Map(); // col -> {startRow, endRow, connectedPeople:[]}
  const families = [];
  
  // Process the tree from top to bottom
  for(let i = 0; i < rows.length; i++) {
    const row = rows[i];
    
    // Track active pipes
    for(const pipeCol of row.pipes) {
      if(!pipeTracker.has(pipeCol)) {
        pipeTracker.set(pipeCol, {startRow: i, endRow: i, connectedPeople: []});
      } else {
        pipeTracker.get(pipeCol).endRow = i;
      }
    }
    
    // Check for people on this row
    for(const person of row.persons) {
      // Find the nearest pipe to this person
      let nearestPipe = null;
      let minDist = 999;
      for(const pipeCol of row.pipes) {
        const dist = Math.abs(person.col - pipeCol);
        if(dist < minDist && dist < 10) {
          minDist = dist;
          nearestPipe = pipeCol;
        }
      }
      if(nearestPipe !== null) {
        pipeTracker.get(nearestPipe).connectedPeople.push({id: person.id, row: i});
      }
    }
    
    // Process junctions (/ and \)
    if(row.slashes.length > 0) {
      // Look for / \ patterns (marriage junction)
      const leftSlashes = row.slashes.filter(s => s.type === '/');
      const rightSlashes = row.slashes.filter(s => s.type === '\\');
      
      for(const left of leftSlashes) {
        for(const right of rightSlashes) {
          if(right.col > left.col && right.col - left.col < 30) {
            // Found a junction
            const midpoint = Math.floor((left.col + right.col) / 2);
            
            // Find parents (people above the junction)
            const parents = [];
            
            // Left parent: person above and near the /
            for(let j = i-1; j >= 0 && j >= i-4; j--) {
              const p = rows[j].persons.find(p => Math.abs(p.col - left.col) < 10);
              if(p) { parents.push(p.id); break; }
            }
            
            // Right parent: person near the \ (could be on same row as left parent or below)
            // First check if there's someone to the right on the junction row or below
            for(let j = i; j <= i+1 && j < rows.length; j++) {
              const p = rows[j].persons.find(p => Math.abs(p.col - right.col) < 10);
              if(p && !parents.includes(p.id)) { parents.push(p.id); break; }
            }
            
            // Find child (person below the junction midpoint)
            let child = null;
            for(let j = i+1; j < rows.length && j <= i+8; j++) {
              const p = rows[j].persons.find(p => Math.abs(p.col - midpoint) < 15);
              if(p) { child = p.id; break; }
            }
            
            if(parents.length > 0 && child !== null) {
              families.push({parents: parents.slice(0,2), children: [child]});
              logs.push({type:'family-from-junction', parents, child, row:i});
            }
          }
        }
      }
      
      // Process single slashes (direct parent-child)
      for(const slash of row.slashes) {
        // Skip if this slash is part of a junction we already processed
        const isPartOfJunction = row.slashes.some(s => 
          s.type !== slash.type && Math.abs(s.col - slash.col) < 30
        );
        
        if(!isPartOfJunction) {
          // Find parent above
          let parent = null;
          for(let j = i-1; j >= 0 && j >= i-4; j--) {
            const p = rows[j].persons.find(p => Math.abs(p.col - slash.col) < 10);
            if(p) { parent = p.id; break; }
          }
          
          // Find child below
          let child = null;
          for(let j = i+1; j < rows.length && j <= i+6; j++) {
            const p = rows[j].persons.find(p => Math.abs(p.col - slash.col) < 10);
            if(p) { child = p.id; break; }
          }
          
          if(parent !== null && child !== null) {
            // Check for spouse on same row as parent
            const parentData = people[parent];
            let spouse = null;
            const parentRow = rows[parentData.line];
            for(const p of parentRow.persons) {
              if(p.id !== parent && Math.abs(p.col - parentData.col) < 50) {
                spouse = p.id;
                break;
              }
            }
            
            const parents = spouse !== null ? [parent, spouse] : [parent];
            
            // Check if family already exists
            const existingFamily = families.find(f => 
              f.parents.length === parents.length &&
              f.parents.every(p => parents.includes(p))
            );
            
            if(existingFamily) {
              if(!existingFamily.children.includes(child)) {
                existingFamily.children.push(child);
              }
            } else {
              families.push({parents, children: [child]});
            }
            
            logs.push({type:'family-from-slash', parents, child, row:i});
          }
        }
      }
    }
  }
  
  // Merge duplicate families
  const mergedFamilies = [];
  const familyMap = new Map();
  
  for(const family of families) {
    const key = family.parents.slice().sort().join('|');
    if(!familyMap.has(key)) {
      familyMap.set(key, {parents: family.parents, children: []});
      mergedFamilies.push(familyMap.get(key));
    }
    const fam = familyMap.get(key);
    for(const child of family.children) {
      if(!fam.children.includes(child)) {
        fam.children.push(child);
      }
    }
  }
  
  logs.push({type:'pipe-tracker', pipes: Array.from(pipeTracker.entries())});
  logs.push({type:'families-summary', count:mergedFamilies.length, families:mergedFamilies});
  
  return { people, families: mergedFamilies, logs };
}

// V5 Parser - Family reduction with robust segment pairing and orientation scoring
function parseIndividualsFromPreV5(result){
  const logs=[];
  const text=(result.text||'').replace(/\u00a0/g,' ');
  const lines=text.split(/\r?\n/);

  // Anchors with sex/color and href
  let anchors=[];
  if(Array.isArray(result.anchors)&&result.anchors.length){
    anchors=result.anchors.map(a=>({ label:(a.label||'').trim(), href:a.href||'', color:(a.color||'').toLowerCase() }));
  } else {
    const container=document.createElement('div'); container.innerHTML=result.html||'';
    anchors=Array.from(container.querySelectorAll('a')).map(a=>{ const font=a.querySelector('font'); return { label:(a.textContent||'').trim(), href:a.getAttribute('href')||'', color:(font?.getAttribute('color')||'').toLowerCase() }; });
  }

  // Build people from anchors by locating labels in lines
  const people=[];
  const linePeople=new Map(); // line -> [{id,col,width}]
  for(let i=0;i<lines.length;i++){
    const s=lines[i];
    for(const a of anchors){
      const label=a.label; if(!label) continue;
      const idx=s.indexOf(label);
      if(idx!==-1){
        const sex=a.color==='red'?'F':a.color==='blue'?'M':'U';
        const url=resolveGedUrl(a.href||'');
        const parsed=parsePersonLabel(label);
        const id=people.length;
        people.push({ id, sex, url, name: parsed.name, birth: parsed.birth, death: parsed.death, line:i, col:idx, width: label.length, indent:idx });
        if(!linePeople.has(i)) linePeople.set(i, []);
        linePeople.get(i).push({ id, col: idx, width: label.length });
      }
    }
    if(linePeople.has(i)) linePeople.get(i).sort((a,b)=>a.col-b.col);
  }

  // Grid and tokenization
  const maxLen=Math.max(0,...lines.map(l=>l.length));
  const grid=lines.map(s=>s.padEnd(maxLen,' ').split(''));
  function tokenizeRow(i){ const lefts=[]; const rights=[]; const pipes=[]; const row=grid[i]||[]; for(let c=0;c<row.length;c++){ const ch=row[c]; if(ch==='/' ) lefts.push(c); else if(ch==='\\') rights.push(c); else if(ch==='|') pipes.push(c); } return { lefts, rights, pipes }; }

  // Pair segments on each slash row using stack (non-overlapping)
  const segmentsByRow=new Map(); // row -> [{l,r,mid}]
  for(let i=0;i<grid.length;i++){
    const {lefts, rights}=tokenizeRow(i); if(!lefts.length && !rights.length) continue; if(!lefts.length || !rights.length) continue;
    const segs=[]; const stack=[]; let ri=0;
    // Build list of sorted positions with markers
    const tokens=[...lefts.map(c=>({c,t:'L'})), ...rights.map(c=>({c,t:'R'}))].sort((a,b)=>a.c-b.c);
    for(const tok of tokens){ if(tok.t==='L'){ stack.push(tok.c); } else { if(stack.length){ const l=stack.pop(); const r=tok.c; if(r>l){ segs.push({ l, r, mid: Math.floor((l+r)/2) }); } } } }
    if(segs.length){ segmentsByRow.set(i, segs); logs.push({ type:'v5-segments', row:i, segs }); }
  }

  // Helpers to find nearest person above/below near a column
  function personNearOnLine(i, col, tol){ const list=linePeople.get(i)||[]; let best=null, bestd=1e9; for(const p of list){ const center=p.col + (p.width||0)/2; const d=Math.abs(center-col); if(d<=tol && d<bestd){ best=p; bestd=d; } } return best?best.id:null; }
  function findUp(i, col, tol, maxStep){ let steps=0; for(let r=i-1;r>=0 && steps++<(maxStep||40); r--){ const id=personNearOnLine(r,col,tol||12); if(id!=null) return id; } return null; }
  function findDown(i, col, tol, maxStep){ let steps=0; for(let r=i+1;r<grid.length && steps++<(maxStep||40); r++){ const id=personNearOnLine(r,col,tol||12); if(id!=null) return id; } return null; }
  function pipeScoreBelow(i, col, K){ let score=0; for(let k=1;k<=K && i+k<grid.length;k++){ const {pipes,lefts,rights}=tokenizeRow(i+k); if(pipes.some(pc=>Math.abs(pc-col)<=1)) score++; else if(lefts.some(l=>l<col)&&rights.some(r=>r>col)) score++; else break; } return score; }
  function pipeScoreAbove(i, col, K){ let score=0; for(let k=1;k<=K && i-k>=0;k++){ const {pipes,lefts,rights}=tokenizeRow(i-k); if(pipes.some(pc=>Math.abs(pc-col)<=1)) score++; else if(lefts.some(l=>l<col)&&rights.some(r=>r>col)) score++; else break; } return score; }

  const rawFamilies=[]; const childClaim=new Map(); // childId -> {row, dist}

  // Evaluate each segment for orientation and build family
  for(const [row, segs] of segmentsByRow.entries()){
    for(const seg of segs){
      const { l, r, mid }=seg;
      // Scores
      const downScore=pipeScoreBelow(row, mid, 8);
      const upScore=pipeScoreAbove(row, mid, 8);

      // Try parents-above, child-below
      const pLeftUp=findUp(row, l, 14, 40);
      const pRightUp=findUp(row, r, 14, 40);
      const childDown=findDown(row, mid, 16, 40);

      // Try parents-below, child-above
      const pLeftDown=findDown(row, l, 14, 40);
      const pRightDown=findDown(row, r, 14, 40);
      const childUp=findUp(row, mid, 16, 40);

      let orientation=null; let parents=[]; let child=null; let choiceLog={};
      // Prefer orientation with valid trio and higher pipe score
      const upValid=(pLeftUp!=null||pRightUp!=null)&&childDown!=null;
      const downValid=(pLeftDown!=null||pRightDown!=null)&&childUp!=null;
      if(upValid && !downValid){ orientation='up'; parents=[pLeftUp,pRightUp].filter(x=>x!=null); child=childDown; }
      else if(!upValid && downValid){ orientation='down'; parents=[pLeftDown,pRightDown].filter(x=>x!=null); child=childUp; }
      else if(upValid && downValid){ if(downScore>upScore){ orientation='down'; parents=[pLeftDown,pRightDown].filter(x=>x!=null); child=childUp; } else { orientation='up'; parents=[pLeftUp,pRightUp].filter(x=>x!=null); child=childDown; } }
      else { // neither solid; skip
        logs.push({ type:'v5-skip-seg', row, seg, reason:'no-valid-orientation', scores:{upScore,downScore}, candidates:{ pLeftUp,pRightUp,childDown,pLeftDown,pRightDown,childUp } });
        continue;
      }

      // Claim child with closest mid distance if conflict
      const childPos=(people.find(p=>p.id===child)||{}).col||mid; const dist=Math.abs(childPos-mid);
      const prev=childClaim.get(child);
      if(prev && prev.dist<=dist){ logs.push({ type:'v5-child-conflict-skip', row, seg, child, prev }); continue; }
      childClaim.set(child, { row, dist });

      const uniqParents=Array.from(new Set(parents)).slice(0,2);
      if(!uniqParents.length){ logs.push({ type:'v5-no-parents', row, seg, child }); continue; }
      rawFamilies.push({ parents: uniqParents, children:[child], row, orient: orientation });
      logs.push({ type:'v5-family', row, seg, orientation, parents: uniqParents, child });
    }
  }

  // Fallback: isolated single slashes as direct edges
  for(let i=0;i<grid.length;i++){
    if(segmentsByRow.has(i)) continue;
    const { lefts, rights }=tokenizeRow(i);
    for(const l of lefts){ const par=findUp(i,l,12,30); const ch=findDown(i,l-1,14,30) ?? findDown(i,l,12,30); if(par!=null && ch!=null){ rawFamilies.push({ parents:[par], children:[ch], row:i, orient:'single/' }); logs.push({ type:'v5-single', char:'/', row:i, par, ch }); } }
    for(const r of rights){ const par=findDown(i,r,12,30); const ch=findUp(i,r-1,14,30) ?? findUp(i,r,12,30); if(par!=null && ch!=null){ rawFamilies.push({ parents:[par], children:[ch], row:i, orient:'single\\' }); logs.push({ type:'v5-single', char:'\\', row:i, par, ch }); } }
  }

  // Merge families by parent set and unique children
  const famMap=new Map();
  for(const fam of rawFamilies){ const key=(fam.parents||[]).slice().sort((a,b)=>a-b).join('|'); if(!famMap.has(key)) famMap.set(key,{ parents:(fam.parents||[]).slice(0,2), children:[] }); const dst=famMap.get(key); for(const c of fam.children||[]){ if(!dst.children.includes(c)) dst.children.push(c); } }
  const families=[...famMap.values()];
  logs.push({ type:'v5-summary', people:people.length, families:families.length });
  return { people, families, logs };
}

// V6 Parser - Alternating CSV-style (person/connector) reduction using pipe order, not pixel columns
function parseIndividualsFromPreV6(result){
  const logs=[];
  const text=(result.text||'').replace(/\u00a0/g,' ');
  const lines=text.split(/\r?\n/);

  // Extract anchors -> people with label positions; we'll still use label col to map person to nearest pipe order
  let anchors=[];
  if(Array.isArray(result.anchors)&&result.anchors.length){ anchors=result.anchors.map(a=>({ label:(a.label||'').trim(), href:a.href||'', color:(a.color||'').toLowerCase() })); }
  else { const container=document.createElement('div'); container.innerHTML=result.html||''; anchors=Array.from(container.querySelectorAll('a')).map(a=>{ const font=a.querySelector('font'); return { label:(a.textContent||'').trim(), href:a.getAttribute('href')||'', color:(font?.getAttribute('color')||'').toLowerCase() }; }); }

  // Build per-row tokens: pipe order indices, slash segments, and persons
  const rowInfo=[]; // {i, pipes:[{idx,col}], slash:'/'|'\\'|'//\\'|'\\//', persons:[{id,col}]}
  const people=[]; const linePeople=new Map();
  for(let i=0;i<lines.length;i++){
    const s=lines[i];
    // Pipes with order index
    const pipes=[]; let order=0; for(let c=0;c<s.length;c++){ if(s[c]==='|'){ pipes.push({ idx:order++, col:c }); } }
    // Slashes
    const lefts=[]; const rights=[]; for(let c=0;c<s.length;c++){ if(s[c]==='/') lefts.push(c); else if(s[c]==='\\') rights.push(c); }
    let slashKind=null; if(lefts.length && rights.length) slashKind='J'; else if(lefts.length) slashKind='/'; else if(rights.length) slashKind='\\';
    // Persons
    const persons=[]; for(const a of anchors){ const idx=s.indexOf(a.label); if(idx!==-1){ const sex=a.color==='red'?'F':a.color==='blue'?'M':'U'; const url=resolveGedUrl(a.href||''); const parsed=parsePersonLabel(a.label); const id=people.length; people.push({ id, sex, url, name: parsed.name, birth: parsed.birth, death: parsed.death, line:i, col:idx }); persons.push({ id, col: idx }); if(!linePeople.has(i)) linePeople.set(i, []); linePeople.get(i).push({ id, col: idx }); } }
    rowInfo.push({ i, text:s, pipes, lefts, rights, slashKind, persons });
  }

  // Helper: nearest person above/below by column, but scoring by pipe order index proximity
  function nearestPersonUp(i, targetCol, tolCol){ for(let r=i-1;r>=0;r--){ const list=linePeople.get(r)||[]; if(list.length){ let best=null, bestd=1e9; for(const p of list){ const d=Math.abs(p.col-targetCol); if(d<bestd){ best=p; bestd=d; } } if(best && bestd<= (tolCol||32)) return best.id; } } return null; }
  function nearestPersonDown(i, targetCol, tolCol){ for(let r=i+1;r<rowInfo.length;r++){ const list=linePeople.get(r)||[]; if(list.length){ let best=null, bestd=1e9; for(const p of list){ const d=Math.abs(p.col-targetCol); if(d<bestd){ best=p; bestd=d; } } if(best && bestd<= (tolCol||32)) return best.id; } } return null; }
  function nearestPipeCol(i, col){ const ps=rowInfo[i]?.pipes||[]; if(!ps.length) return null; let best=ps[0].col, bestd=Math.abs(ps[0].col-col); for(const p of ps){ const d=Math.abs(p.col-col); if(d<bestd){ best=p.col; bestd=d; } } return best; }

  // Build segments for junction rows using simple pairing
  const segsByRow=new Map();
  for(const row of rowInfo){ if(row.slashKind!=='J') continue; const segs=[]; let ri=0; for(const L of row.lefts){ while(ri<row.rights.length && row.rights[ri]<=L) ri++; if(ri>=row.rights.length) break; const R=row.rights[ri++]; const mid=Math.floor((L+R)/2); segs.push({ L, R, mid, Lp: nearestPipeCol(row.i,L), Rp: nearestPipeCol(row.i,R), Mp: nearestPipeCol(row.i,mid) }); } if(segs.length) segsByRow.set(row.i,segs); }

  const families=[]; const childClaim=new Map();
  // Process rows in descending pipe count for reduction-first semantics
  const rowsByPipeCount=[...rowInfo].sort((a,b)=> (b.pipes.length)-(a.pipes.length));
  for(const row of rowsByPipeCount){ if(row.slashKind!=='J') continue; const segs=segsByRow.get(row.i)||[]; for(const seg of segs){ const leftParent=nearestPersonUp(row.i, seg.Lp ?? seg.L, 28); const rightParent=nearestPersonUp(row.i, seg.Rp ?? seg.R, 28); const child=nearestPersonDown(row.i, seg.Mp ?? seg.mid, 32); if(child==null) { logs.push({ type:'v6-no-child', row:row.i, seg}); continue; } const prev=childClaim.get(child); const childCol=(people.find(p=>p.id===child)||{}).col||seg.mid; const dist=Math.abs(childCol-(seg.Mp??seg.mid)); if(prev && prev.dist<=dist){ logs.push({ type:'v6-child-conflict-skip', row:row.i, seg, child }); continue; } childClaim.set(child,{ row:row.i, dist }); const parents=[]; if(leftParent!=null) parents.push(leftParent); if(rightParent!=null && rightParent!==leftParent) parents.push(rightParent); if(!parents.length){ logs.push({ type:'v6-no-parents', row:row.i, seg, child}); continue; } const key=parents.slice().sort((a,b)=>a-b).join('|'); let fam=families.find(f=>f._key===key); if(!fam){ fam={ parents: parents.slice(0,2), children:[], _key:key }; families.push(fam); } if(!fam.children.includes(child)) fam.children.push(child); logs.push({ type:'v6-family', row:row.i, seg, parents: fam.parents, child }); }
  }

  // Fallback for single slashes
  for(const row of rowInfo){ if(row.slashKind==='/'||row.slashKind==='\\'){ const cols=row.slashKind==='/'?row.lefts:row.rights; for(const c of cols){ const parent=row.slashKind==='/'?nearestPersonUp(row.i,c,28):nearestPersonDown(row.i,c,28); const child=row.slashKind==='/'?nearestPersonDown(row.i,c,28):nearestPersonUp(row.i,c,28); if(parent!=null && child!=null){ const key=[parent].join('|'); let fam=families.find(f=>f._key===key); if(!fam){ fam={ parents:[parent], children:[], _key:key }; families.push(fam); } if(!fam.children.includes(child)) fam.children.push(child); logs.push({ type:'v6-single', row:row.i, c, parent, child }); } } } }

  // Strip helper props and return
  families.forEach(f=>{ delete f._key; });
  return { people, families, logs };
}

// V7 Parser - Indent-guided reduction into family units (adjacent 5-row and 3-row windows)
function parseIndividualsFromPreV7(result){
  const logs=[];
  const text=(result.text||'').replace(/\u00a0/g,' ');
  const lines=text.split(/\r?\n/);

  // Anchors
  let anchors=[];
  if(Array.isArray(result.anchors)&&result.anchors.length){ anchors=result.anchors.map(a=>({ label:(a.label||'').trim(), href:a.href||'', color:(a.color||'').toLowerCase() })); }
  else { const container=document.createElement('div'); container.innerHTML=result.html||''; anchors=Array.from(container.querySelectorAll('a')).map(a=>{ const font=a.querySelector('font'); return { label:(a.textContent||'').trim(), href:a.getAttribute('href')||'', color:(font?.getAttribute('color')||'').toLowerCase() }; }); }

  // Build people and rows
  const people=[]; const linePeople=new Map();
  for(let i=0;i<lines.length;i++){
    const s=lines[i];
    for(const a of anchors){ const idx=s.indexOf(a.label); if(idx!==-1){ const sex=a.color==='red'?'F':a.color==='blue'?'M':'U'; const url=resolveGedUrl(a.href||''); const parsed=parsePersonLabel(a.label); const id=people.length; people.push({ id, sex, url, name: parsed.name, birth: parsed.birth, death: parsed.death, line:i, col:idx }); if(!linePeople.has(i)) linePeople.set(i, []); linePeople.get(i).push({ id, col: idx }); }}
    if(linePeople.has(i)) linePeople.get(i).sort((a,b)=>a.col-b.col);
  }

  function tokenizeCharRow(i){ const s=lines[i]||''; const lefts=[]; const rights=[]; const pipes=[]; for(let c=0;c<s.length;c++){ const ch=s[c]; if(ch==='/' ) lefts.push(c); else if(ch==='\\') rights.push(c); else if(ch==='|') pipes.push(c); } return { lefts, rights, pipes }; }
  function buildSegments(i){ const {lefts, rights}=tokenizeCharRow(i); if(!lefts.length||!rights.length) return []; const segs=[]; let rIdx=rights.length-1; for(const l of lefts){ while(rIdx>=0 && rights[rIdx]<=l) rIdx--; if(rIdx<0) break; const r=rights[rIdx--]; if(r>l) segs.push({ L:l, R:r, mid:Math.floor((l+r)/2) }); } return segs.sort((a,b)=>a.L-b.L); }
  function personOnLineNear(i, col, tol){ const list=linePeople.get(i)||[]; if(!list.length) return null; let best=null, bestd=1e9; for(const p of list){ const d=Math.abs(p.col-col); if(d<bestd){ best=p; bestd=d; } } return bestd<=tol?best.id:null; }

  // Build row objects
  const rows=[]; for(let i=0;i<lines.length;i++){ if(linePeople.has(i)) rows.push({ idx:i, type:'person', persons: linePeople.get(i), text: lines[i] }); else { const t=tokenizeCharRow(i); const segs=buildSegments(i); const slashKind=(t.lefts.length&&t.rights.length)?'J':(t.lefts.length?'/':(t.rights.length?'\\':null)); rows.push({ idx:i, type:'char', pipes:t.pipes, lefts:t.lefts, rights:t.rights, segments:segs, slashKind, text: lines[i] }); }}

  // Estimate indent per person row from first non-space column (fallback: person col / 4)
  for(const row of rows){ if(row.type==='person'){ for(const p of row.persons){ const s=lines[row.idx]; const firstCol=(s.match(/^\s*/)[0]||'').length; const indent = Math.max(0, Math.floor((firstCol||p.col)/4)); p.indent=indent; const person=people.find(x=>x.id===p.id); if(person) person.indent=indent; } } }

  const families=[]; const removedRow=new Set(); const claimedChild=new Set();

  function addFamily(parents, child, context){ if(!parents.length||child==null) return false; const uniqParents=Array.from(new Set(parents)).slice(0,2); if(!uniqParents.length) return false; families.push({ parents: uniqParents, children:[child] }); logs.push({ type:'v7-family', ...context, parents: uniqParents, child }); return true; }

  // Pass A: 5-row window reduction [parent]-[char]-[child]-[char]-[parent]
  for(let i=0;i+4<rows.length;i++){
    const r0=rows[i], r1=rows[i+1], r2=rows[i+2], r3=rows[i+3], r4=rows[i+4];
    if(r0.type!=='person'||r1.type!=='char'||r2.type!=='person'||r3.type!=='char'||r4.type!=='person') continue;
    if(!r1.segments.length || !r3.segments.length) continue;
    // choose child (single person assumption)
    const childId=(r2.persons[0]||{}).id; if(childId==null || claimedChild.has(childId)) continue;
    const childCol=(r2.persons[0]||{}).col||0;
    // pick nearest segments by midpoint
    const segUp=r1.segments.reduce((b,s)=> !b||Math.abs(s.mid-childCol)<Math.abs(b.mid-childCol)?s:b, null);
    const segDown=r3.segments.reduce((b,s)=> !b||Math.abs(s.mid-childCol)<Math.abs(b.mid-childCol)?s:b, null);
    // resolve parents near L/R of each segment
    const pUpLeft = personOnLineNear(r0.idx, segUp.L, 24);
    const pDownRight = personOnLineNear(r4.idx, segDown.R, 24);
    const parents=[]; if(pUpLeft!=null) parents.push(pUpLeft); if(pDownRight!=null && pDownRight!==pUpLeft) parents.push(pDownRight);
    if(addFamily(parents, childId, { mode:'5row', rows:[r0.idx,r1.idx,r2.idx,r3.idx,r4.idx] })){
      removedRow.add(r0.idx); removedRow.add(r4.idx); claimedChild.add(childId);
    }
  }

  // Pass B: 3-row windows for single-parent edges above or below
  for(let i=0;i+2<rows.length;i++){
    const ra=rows[i], rb=rows[i+1], rc=rows[i+2];
    if(ra.type==='person' && rb.type==='char' && rc.type==='person'){
      const child=(rc.persons[0]||{}).id; if(child==null || claimedChild.has(child)) continue;
      if(rb.lefts.length||rb.rights.length){
        const nearL=rb.lefts.length?rb.lefts[0]:null; const nearR=rb.rights.length?rb.rights[rb.rights.length-1]:null; const parent = personOnLineNear(ra.idx, (nearL!=null?nearL:nearR), 24);
        if(parent!=null){ if(addFamily([parent], child, { mode:'3row-above', rows:[ra.idx,rb.idx,rc.idx] })) { removedRow.add(ra.idx); claimedChild.add(child); } }
      }
    }
    if(ra.type==='char' && rb.type==='person' && rc.type==='char'){
      // symmetric case not needed for families; handled in 5-row
    }
    if(ra.type==='person' && rb.type==='char' && rc.type==='char'){
      // skip
    }
    // Below: person(child) centered between char and person(parent)
    if(ra.type==='person' && rb.type==='char' && rc.type==='person'){
      // already covered
    }
  }

  // Merge duplicates and ensure child links are unique
  const famMap=new Map();
  for(const fam of families){ const key=(fam.parents||[]).slice().sort((a,b)=>a-b).join('|'); if(!famMap.has(key)) famMap.set(key, { parents:(fam.parents||[]).slice(0,2), children:[] }); const dst=famMap.get(key); for(const c of fam.children||[]){ if(!dst.children.includes(c)) dst.children.push(c); } }
  const outFamilies=[...famMap.values()];
  logs.push({ type:'v7-summary', people: people.length, families: outFamilies.length });
  return { people, families: outFamilies, logs };
}

// V4 Parser - Grid-based bidirectional tracing (/ \ |) into parent-child graph
function parseIndividualsFromPreV4(result){
  const logs=[];
  const text=(result.text||'').replace(/\u00a0/g,' ');
  const lines=text.split(/\r?\n/);

  // Collect anchors with sex/color and href
  let anchors=[];
  if(Array.isArray(result.anchors)&&result.anchors.length){
    anchors=result.anchors.map(a=>({ label:(a.label||'').trim(), href:a.href||'', color:(a.color||'').toLowerCase() }));
  } else {
    const container=document.createElement('div'); container.innerHTML=result.html||'';
    anchors=Array.from(container.querySelectorAll('a')).map(a=>{ const font=a.querySelector('font'); return { label:(a.textContent||'').trim(), href:a.getAttribute('href')||'', color:(font?.getAttribute('color')||'').toLowerCase() }; });
  }

  // Index people by scanning anchors on their lines; record approximate label width
  const people=[];
  const linePeople=new Map(); // line -> [{id,col,width}]
  for(let i=0;i<lines.length;i++){
    const s=lines[i];
    for(const a of anchors){
      const label=a.label; if(!label) continue;
      const idx=s.indexOf(label);
      if(idx!==-1){
        const sex=a.color==='red'?'F':a.color==='blue'?'M':'U';
        const url=resolveGedUrl(a.href||'');
        const parsed=parsePersonLabel(label);
        const id=people.length;
        people.push({ id, sex, url, name: parsed.name, birth: parsed.birth, death: parsed.death, line:i, col:idx, width: label.length, indent:idx });
        if(!linePeople.has(i)) linePeople.set(i, []);
        linePeople.get(i).push({ id, col: idx, width: label.length });
      }
    }
    if(linePeople.has(i)) linePeople.get(i).sort((a,b)=>a.col-b.col);
  }

  // Build grid for connector tracing
  const maxLen=Math.max(0,...lines.map(l=>l.length));
  const grid=lines.map(s=>s.padEnd(maxLen,' ').split(''));

  // Helpers
  function personOnLineNear(lineIdx, col, tol){
    const list=linePeople.get(lineIdx)||[]; let best=null, bestd=1e9;
    for(const p of list){ const center=p.col + (p.width||0)/2; const d=Math.abs(center-col); if(d<=tol && d<bestd){ best=p; bestd=d; } }
    return best?best.id:null;
  }
  function findPersonUpwards(startRow, col, tolCol, maxSteps){
    let steps=0; for(let r=startRow-1; r>=0 && steps++<(maxSteps||40); r--){ const id=personOnLineNear(r,col,tolCol||12); if(id!=null) return id; }
    return null;
  }
  function findPersonDownwards(startRow, col, tolCol, maxSteps){
    let steps=0; for(let r=startRow+1; r<grid.length && steps++<(maxSteps||40); r++){ const id=personOnLineNear(r,col,tolCol||12); if(id!=null) return id; }
    return null;
  }
  function rowSlashes(i){ const lefts=[]; const rights=[]; const pipes=[]; const row=grid[i]||[]; for(let c=0;c<row.length;c++){ const ch=row[c]; if(ch==='/' ) lefts.push(c); else if(ch==='\\') rights.push(c); else if(ch==='|') pipes.push(c); } return { lefts, rights, pipes }; }
  function hasPipeWithinKBelow(i, col, K){ for(let k=1;k<=K && i+k<grid.length;k++){ const r=rowSlashes(i+k); for(const pc of r.pipes){ if(Math.abs(pc-col)<=1) return true; } // also consider being inside a junction segment
    const rs=rowSlashes(i+k); for(const l of rs.lefts){ for(const rr of rs.rights){ if(l<rr && l<col && col<rr) return true; } } }
    return false; }

  const rawFamilies=[]; // {parents:[p1,p2?], children:[...]} before merge

  // Pass 1: process junction rows that contain both / and \
  for(let i=0;i<grid.length;i++){
    const rs=rowSlashes(i); if(!rs.lefts.length || !rs.rights.length) continue;
    // Greedy pairing
    let rIdx=0;
    for(const l of rs.lefts){ while(rIdx<rs.rights.length && rs.rights[rIdx]<=l) rIdx++; if(rIdx>=rs.rights.length) break; const r=rs.rights[rIdx++]; if(r-l>80) continue; const mid=Math.floor((l+r)/2);
      // Parents above
      const pLeft=findPersonUpwards(i,l,12,40);
      const pRight=findPersonUpwards(i,r,12,40);
      // Child below via midpoint and pipe continuity
      const child=(hasPipeWithinKBelow(i,mid,6))?findPersonDownwards(i,mid,15,40):findPersonDownwards(i,mid,10,6);
      logs.push({ type:'v4-junction', row:i, l, r, mid, pLeft, pRight, child });
      const parents=[]; if(pLeft!=null) parents.push(pLeft); if(pRight!=null && pRight!==pLeft) parents.push(pRight);
      if((parents.length||0) && child!=null){ rawFamilies.push({ parents: parents.slice(0,2), children:[child] }); }
    }
  }

  // Pass 2: single slashes indicating direct parent-child edges
  for(let i=0;i<grid.length;i++){
    const rs=rowSlashes(i); const hasJunction=rs.lefts.length && rs.rights.length;
    if(hasJunction) continue; // already handled by junction pass
    // Process isolated '/'
    for(const l of rs.lefts){
      const parent=findPersonUpwards(i,l,12,40);
      const child=findPersonDownwards(i,l-2,15,40) ?? findPersonDownwards(i,l,12,40);
      if(parent!=null && child!=null){ rawFamilies.push({ parents:[parent], children:[child] }); logs.push({ type:'v4-single-slash', char:'/', row:i, col:l, parent, child }); }
    }
    // Process isolated '\\'
    for(const r of rs.rights){
      const parent=findPersonDownwards(i,r,12,40);
      const child=findPersonUpwards(i,r-2,15,40) ?? findPersonUpwards(i,r,12,40);
      if(parent!=null && child!=null){ rawFamilies.push({ parents:[parent], children:[child] }); logs.push({ type:'v4-single-slash', char:'\\', row:i, col:r, parent, child }); }
    }
  }

  // Merge duplicate families by parent set and unique children
  const merged=[]; const famMap=new Map();
  for(const fam of rawFamilies){ const key=(fam.parents||[]).slice().sort((a,b)=>a-b).join('|'); if(!famMap.has(key)) famMap.set(key, { parents:(fam.parents||[]).slice(0,2), children: [] }); const dst=famMap.get(key); for(const c of fam.children||[]){ if(!dst.children.includes(c)) dst.children.push(c); } }
  for(const v of famMap.values()) merged.push(v);

  logs.push({ type:'v4-summary', people: people.length, families: merged.length });
  return { people, families: merged, logs };
}

function buildGedcom(people, meta, families){
  const now=new Date(); const yyyy=now.getFullYear(); const mm=String(now.getMonth()+1).padStart(2,'0'); const dd=String(now.getDate()).padStart(2,'0');
  const head=[ '0 HEAD','1 SOUR GedMapper','2 NAME GedMapper GEDmatch Capture','2 VERS 0.1','1 DATE '+`${yyyy}-${mm}-${dd}`,'1 SUBM @SUB1@','1 GEDC','2 VERS 5.5.1','2 FORM LINEAGE-LINKED','1 CHAR UTF-8' ]; if(meta?.kit) head.push('1 _OM_REFERENCE_KIT '+meta.kit);
  const subm=[ '0 @SUB1@ SUBM','1 NAME GEDmatch Importer User' ];
  const indiPtr = (i)=>`@I${i+1}@`; // index based on array order
  const blocks = people.map((p,i)=>{ const lines=[`0 ${indiPtr(i)} INDI`, `1 NAME ${p.name || 'Unknown'}`, `1 SEX ${p.sex || 'U'}`]; if(p.birth?.date || p.birth?.place){ lines.push('1 BIRT'); if(p.birth.date) lines.push(`2 DATE ${p.birth.date}`); if(p.birth.place) lines.push(`2 PLAC ${p.birth.place}`);} if(p.death?.date || p.death?.place){ lines.push('1 DEAT'); if(p.death.date) lines.push(`2 DATE ${p.death.date}`); if(p.death.place) lines.push(`2 PLAC ${p.death.place}`);} if(p.url) lines.push(`1 NOTE _OM_SOURCE_URL ${p.url}`); return { lines, fLinks: [] }; });
  // Families
  const famBlocks=[]; const famPtr=(i)=>`@F${i+1}@`;
  families.forEach((fam, fi)=>{
    const ptr=famPtr(fi); const lines=[`0 ${ptr} FAM`]; let p1=fam.parents?.[0]; let p2=fam.parents?.[1]; if(p1==null && p2==null) return; const parent1=people[p1]; const parent2=p2!=null?people[p2]:null; // Assign roles
    let hus=null, wif=null; if(parent1 && parent2){ if(parent1.sex==='M' || parent2.sex==='F'){ hus=p1; wif=p2; } else if(parent2.sex==='M' || parent1.sex==='F'){ hus=p2; wif=p1; } else { hus=p1; wif=p2; } } else if(parent1){ if(parent1.sex==='M') hus=p1; else wif=p1; }
    if(hus!=null) lines.push(`1 HUSB ${indiPtr(hus)}`); if(wif!=null) lines.push(`1 WIFE ${indiPtr(wif)}`);
    for(const c of fam.children||[]){ lines.push(`1 CHIL ${indiPtr(c)}`); blocks[c].fLinks.push(`1 FAMC ${ptr}`); }
    if(hus!=null) blocks[hus].fLinks.push(`1 FAMS ${ptr}`); if(wif!=null) blocks[wif].fLinks.push(`1 FAMS ${ptr}`);
    famBlocks.push(lines);
  });
  const body=[]; blocks.forEach(b=>{ body.push(...b.lines, ...b.fLinks); });
  const ged=[...head, ...subm, ...body, ...famBlocks.flat(), '0 TRLR'].join('\n');
  return ged;
}

function refreshStatusDots(profiles, statusByKit){ renderList(profiles, statusByKit); }

(async function main(){
  const state = await getState();
  const fileInput = document.getElementById('csvFile');

  fileInput.addEventListener('change', async () => { const file=fileInput.files[0]; if(!file) return; try { const text=await file.text(); await chrome.storage.local.set({ gmPendingCsvText:text, gmGedmatchPendingMeta:{ name:file.name, size:file.size, lastModified:file.lastModified } }); updateStats(state.session.profiles, `Pending: ${file.name}`);} catch(e){ updateStats(state.session.profiles,'Failed to read file'); }});

  document.getElementById('parseBtn').onclick = async () => { const s=await getState(); if(!s.pendingText){ updateStats(s.session.profiles,'No pending file'); return;} const built=buildSessionFromText(s.pendingText); if(built.error){ updateStats([],built.error); return;} await saveSession(built.session); const statusByKit=(await getState()).statusByKit; for(const p of built.session.profiles) if(!statusByKit[p.Kit]) statusByKit[p.Kit]='red'; await saveStatusMap(statusByKit); renderList(built.session.profiles,statusByKit); updateStats(built.session.profiles, s.pendingMeta?.name?`Loaded: ${s.pendingMeta.name}`:undefined); chrome.storage.local.remove(['gmPendingCsvText','gmGedmatchPendingMeta']); };

  document.getElementById('clearSession').onclick = async () => { if(!confirm('This will permanently clear the loaded CSV, parsed list, statuses, and pending data. Continue?')) return; await chrome.storage.local.remove(['gmGedmatchSession','gmGedmatchPendingMeta','gmPendingCsvText','gmStatusByKit','gmFocusedKit','gmCapturedByKit','gmLogsByKit']); document.getElementById('rows').innerHTML=''; document.getElementById('currentBox').classList.add('hidden'); updateStats([],'Cleared'); };

  document.getElementById('btnCapture').onclick = async () => { const st=await getState(); const kit=st.focusedKit; if(!kit){ alert('No focused individual. Click Open on a row first.'); return;} try { const pre=await extractPreFromActiveTab(); const rowsJson=buildIntermediaryRows(pre); const profile=st.session.profiles.find(x=>x.Kit===kit); await saveCapture(kit,{ rowsJson, capturedAt:new Date().toISOString(), sourceUrl: profile?.treeUrl||'' }, [{ type:'rows-summary', total: rowsJson.totalLines, personLines: rowsJson.personLines, charLines: rowsJson.charLines }]); const statusByKit=st.statusByKit; statusByKit[kit]='yellow'; await saveStatusMap(statusByKit); setCurrentBox(profile,'yellow'); refreshStatusDots(st.session.profiles,statusByKit); updateStats(st.session.profiles, `Rows JSON built: ${rowsJson.personLines} person rows, ${rowsJson.charLines} char rows`);} catch(e){ console.error('Capture failed',e); alert('Capture failed: '+(e?.message||e)); } };

  document.getElementById('btnFinalize').onclick = async () => { const st=await getState(); const kit=st.focusedKit; if(!kit) return; const statusByKit=st.statusByKit; statusByKit[kit]='green'; await saveStatusMap(statusByKit); const profile=st.session.profiles.find(x=>x.Kit===kit); setCurrentBox(profile,'green'); refreshStatusDots(st.session.profiles,statusByKit); };

  document.getElementById('btnClearCopy').onclick = async () => { const st=await getState(); const kit=st.focusedKit; if(!kit) return; const store=await chrome.storage.local.get(['gmCapturedByKit']); const cap=store.gmCapturedByKit||{}; delete cap[kit]; await chrome.storage.local.set({ gmCapturedByKit: cap }); const statusByKit=st.statusByKit; statusByKit[kit]='red'; await saveStatusMap(statusByKit); const profile=st.session.profiles.find(x=>x.Kit===kit); setCurrentBox(profile,'red'); refreshStatusDots(st.session.profiles,statusByKit); };

  document.getElementById('btnCaptureSub').onclick = () => { alert('Capture Subtree: coming soon'); };

  document.getElementById('btnDownloadGedcom').onclick = async () => { const st=await getState(); const kit=st.focusedKit; if(!kit){ alert('No focused individual.'); return;} const cap=st.capturedByKit[kit]; if(!cap?.gedcom){ alert('No captured GEDCOM for this kit yet. Click Capture Tree first.'); return;} const blob=new Blob([cap.gedcom], { type:'text/plain' }); const url=URL.createObjectURL(blob); const filename=`gedmatch-capture-${kit}.ged`; await chrome.downloads.download({ url, filename, saveAs: true }); setTimeout(()=>URL.revokeObjectURL(url), 10000); };
  document.getElementById('btnDownloadRowsJson').onclick = async () => { const st=await getState(); const kit=st.focusedKit; if(!kit){ alert('No focused individual.'); return;} const store=await chrome.storage.local.get(['gmCapturedByKit']); const cap=store.gmCapturedByKit?.[kit]; if(!cap?.rowsJson){ alert('No captured Rows JSON yet. Click Capture Tree first.'); return;} const blob=new Blob([JSON.stringify(cap.rowsJson, null, 2)], { type:'application/json' }); const url=URL.createObjectURL(blob); const filename=`gedmatch-rows-${kit}.json`; await chrome.downloads.download({ url, filename, saveAs:true }); setTimeout(()=>URL.revokeObjectURL(url), 10000); };

  document.getElementById('btnViewLog').onclick = async () => { const st=await getState(); const kit=st.focusedKit; if(!kit){ alert('No focused individual.'); return;} const logs=(await getState()).logsByKit?.[kit]; if(!logs || !logs.length){ alert('No logs captured yet. Click Capture Tree to generate logs.'); return;} const blob=new Blob([JSON.stringify(logs, null, 2)], { type:'application/json' }); const url=URL.createObjectURL(blob); const filename=`gedmatch-capture-log-${kit}.json`; await chrome.downloads.download({ url, filename, saveAs: true }); setTimeout(()=>URL.revokeObjectURL(url), 10000); };

  document.getElementById('openNext').onclick = async () => { const s=(await getState()).session; if(!s.profiles?.length) return; const i=Math.max(0, Math.min(s.queueIndex||0, s.profiles.length-1)); const p=s.profiles[i]; s.queueIndex=i+1; await saveSession(s); setCurrentBox(p, (await getState()).statusByKit[p.Kit]||'red'); if(p?.treeUrl) await chrome.tabs.create({ url:p.treeUrl, active:true }); };

  document.getElementById('exportJson').onclick = async () => { const s=(await getState()).session; const blob=new Blob([JSON.stringify(s.bundle||{}, null, 2)], { type:'application/json' }); const url=URL.createObjectURL(blob); const filename=`gedmatch-import-${new Date().toISOString().replace(/[:.]/g,'-')}.json`; await chrome.downloads.download({ url, filename, saveAs:true }); setTimeout(()=>URL.revokeObjectURL(url), 10000); };

  const st = await getState(); if (st.session.profiles?.length) { renderList(st.session.profiles, st.statusByKit); updateStats(st.session.profiles, st.pendingMeta?.name ? `Last: ${st.pendingMeta.name}` : undefined); if (st.focusedKit) { const p = st.session.profiles.find(x => x.Kit === st.focusedKit); if (p) setCurrentBox(p, st.statusByKit[p.Kit] || 'red'); } } else if (st.pendingMeta?.name) { updateStats([], `Pending: ${st.pendingMeta.name}`); } else { updateStats([]); }

  // Parse ASCII from textarea using V6
  document.getElementById('btnParseAscii').onclick = async () => {
    const txt=(document.getElementById('asciiText').value||'').trim();
    if(!txt){ alert('Paste the ASCII pedigree into the textbox first.'); return; }
    try {
      const pre={ ok:true, html: txt.replace(/\n/g,'<br>'), text: txt, anchors: [] };
      const { people, families, logs }=parseIndividualsFromPreV7(pre);
      const gedcom=buildGedcom(people, null, families);
      const blob=new Blob([gedcom], { type:'text/plain' });
      const url=URL.createObjectURL(blob);
      await chrome.downloads.download({ url, filename:'gedmatch-ascii-parsed.ged', saveAs:true });
      setTimeout(()=>URL.revokeObjectURL(url), 10000);
      console.log('V6 ASCII parse:', { people:people.length, families:families.length, logs });
      alert(`Parsed ASCII: ${people.length} people, ${families.length} families`);
    } catch(e){ console.error('Parse ASCII failed', e); alert('Parse ASCII failed: '+(e?.message||e)); }
  };
})();
