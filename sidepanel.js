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
  const normalize=(s)=>String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,'');
  const idxNorm=new Map(); header.forEach((h,i)=>idxNorm.set(normalize(h), i));
  const getByAny=(r,keys)=>{ for(const k of keys){ const i=idxNorm.get(normalize(k)); if(i!=null) return r[i] ?? ''; } return ''; };
  return body.map(r=>({
    Kit: getByAny(r,['Kit']),
    Name: getByAny(r,['Name']),
    Email: getByAny(r,['Email']),
    GedLink: getByAny(r,['GED WikiTree','GEDWikiTree','GED Match','GedTree','Tree Link']),
    Sex: getByAny(r,['Sex']),
    AtdnaTotal: getByAny(r,['Total cM - Autosomal','Total cm - Autosomal','Total cM Autosomal','Total cm Autosomal','Autosomal Total cM','Autosomal Total cm']),
    LargestCm: getByAny(r,['Largest - Autosomal','Largest cM - Autosomal','LargestcmAutosomal','Largest cM','Largest cm']),
    Source: getByAny(r,['Source']),
    Overlap: getByAny(r,['Overlap'])
  }));
}

function classifyGedLink(s) {
  const out={ type:'none', url:'', raw: s||'' };
  if(!s) return out; const t=String(s).trim(); if(!t || t==='null') return out;
  let u=null; try { u = /^https?:\/\//i.test(t) ? new URL(t) : null; } catch {}
  if(u){
    const host=u.hostname.toLowerCase();
    if(/wikitree\.com$/i.test(host)) { out.type='wikitree'; out.url=u.toString(); return out; }
    if(/gedmatch\.com$/i.test(host)) { if(host!=='pro.gedmatch.com'){ u.hostname='pro.gedmatch.com'; } out.type='gedmatch'; out.url=u.toString(); return out; }
    // unknown external; ignore
    return out;
  }
  // relative path → gedmatch
  const abs = t.startsWith('/') ? `https://pro.gedmatch.com${t}` : `https://pro.gedmatch.com/${t}`;
  out.type='gedmatch'; out.url=abs; return out;
}

// Normalize in-page anchor hrefs to absolute pro.gedmatch.com URLs (used by parsers)
function resolveGedUrl(s){
  if(!s) return '';
  const t=String(s).trim();
  try {
    const u = /^https?:\/\//i.test(t) ? new URL(t) : new URL(t, 'https://pro.gedmatch.com');
    if(/\.gedmatch\.com$/i.test(u.hostname) && u.hostname !== 'pro.gedmatch.com') u.hostname='pro.gedmatch.com';
    return u.toString();
  } catch { return t; }
}

async function getState() {
  const s = await chrome.storage.local.get(['gmGedmatchSession','gmGedmatchPendingMeta','gmPendingCsvText','gmStatusByKit','gmFocusedKit','gmCapturedByKit','gmLogsByKit','gmAllCsvRecords']);
  return {
    session: s.gmGedmatchSession || { profiles: [], queueIndex: 0, bundle: null },
    pendingMeta: s.gmGedmatchPendingMeta || null,
    pendingText: s.gmPendingCsvText || null,
    statusByKit: s.gmStatusByKit || {},
    focusedKit: s.gmFocusedKit || null,
    capturedByKit: s.gmCapturedByKit || {},
    logsByKit: s.gmLogsByKit || {},
    allRecords: s.gmAllCsvRecords || []
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
  // render tree links if present
  const trees = (profile.__trees||[]);
  const tgt = document.getElementById('currentTrees');
  if (tgt) {
    if (trees.length) {
      const links = trees.map((t,idx)=>`<a href="${t.pedigreeUrl}" target="_blank">Tree ${idx+1}</a>`).join(' · ');
      tgt.innerHTML = `<div class="muted">Detected ${trees.length} tree(s): ${links}</div>`;
    } else {
      tgt.innerHTML = '';
    }
  }
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
  const base = `${withLinks}/${total} with GEDmatch links`;
  document.getElementById('stats').textContent = extra ? `${base} • ${extra}` : base;
}

// Segments CSV parsing and storage
function buildSegmentsFromText(text){
  const rows=parseCsv(text);
  if(!rows.length) return { kits: new Set(), segments: [] };
  const header=rows[0]; const body=rows.slice(1);
  const normalize=(s)=>String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,'');
  const idxNorm=new Map(); header.forEach((h,i)=>idxNorm.set(normalize(h), i));
  const col=(name)=>{ const i=idxNorm.get(normalize(name)); return i==null?-1:i; };
  const iPrimary=col('PrimaryKit'); const iMatched=col('MatchedKit'); const iChr=col('Chr'); const iStart=col('B37 Start'); const iEnd=col('B37 End'); const iCm=col('Segment cM'); const iSnps=col('SNPs'); const iName=col('MatchedName'); const iSex=col('Matched Sex'); const iEmail=col('MatchedEmail');
  const kitsSet=new Set(); const segs=[];
  for(const r of body){
    const primary=r[iPrimary]||''; const matched=r[iMatched]||''; if(primary||matched){ kitsSet.add(primary); kitsSet.add(matched); }
    segs.push({
      primaryKit: primary,
      matchedKit: matched,
      chr: r[iChr]||'',
      b37Start: r[iStart]||'',
      b37End: r[iEnd]||'',
      cm: r[iCm]||'',
      snps: r[iSnps]||'',
      matchedName: r[iName]||'',
      matchedSex: r[iSex]||'',
      matchedEmail: r[iEmail]||''
    });
  }
  return { kits: Array.from(kitsSet).filter(Boolean), segments: segs };
}

// Build an index: kit -> list of segment rows involving that kit
function buildSegmentsIndex(segments){ const map=new Map(); if(!Array.isArray(segments)) return map; for(const s of segments){ const a=(s?.primaryKit||'').trim(); const b=(s?.matchedKit||'').trim(); if(a){ if(!map.has(a)) map.set(a,[]); map.get(a).push(s); } if(b){ if(!map.has(b)) map.set(b,[]); map.get(b).push(s); } } return map; }

function emitSegmentLinesForKit(kit, segList){ const lines=[]; if(!kit||!Array.isArray(segList)) return lines; for(const s of segList){ const pk=(s.primaryKit||'').trim(); const mk=(s.matchedKit||'').trim(); const chr=String(s.chr||'').trim(); const st=String(s.b37Start||'').trim(); const en=String(s.b37End||'').trim(); const cm=String(s.cm||'').trim(); lines.push('1 _OM_SEGMENT_DATA'); lines.push(`2 _OM_PRIMARY_KIT ${pk}`); lines.push(`2 _OM_MATCHED_KIT ${mk}`); lines.push(`2 _OM_CHROMOSOME ${chr}`); lines.push('2 _OM_BUILD B37'); lines.push(`2 _OM_SEGMENT_START ${st}`); lines.push(`2 _OM_SEGMENT_END ${en}`); lines.push(`2 _OM_SEGMENT_CM ${cm}`); lines.push('2 _OM_KIT_SOURCE GEDMATCH'); } return lines; }

function buildSessionFromText(text) {
  const rows = parseCsv(text);
  const { header, body } = normalizeHeaderRow(rows);
  if (header.length === 0) return { error: 'Invalid CSV: header not found' };
  const recs = toRecords(header, body).map(r => { const cl=classifyGedLink(r.GedLink); return { ...r, treeUrl: cl.type==='gedmatch'?cl.url:'', treeType: cl.type, rawTreeLink: cl.raw }; });
  const profiles = recs.filter(r => r.treeType==='gedmatch');
  return { session: { profiles, queueIndex: 0, bundle: { exportedAt: new Date().toISOString(), source: { site: 'GEDmatch' }, profiles, captures: [] } }, allRecords: recs };
}

const MONTHS = { jan:'JAN', feb:'FEB', mar:'MAR', apr:'APR', may:'MAY', jun:'JUN', jul:'JUL', aug:'AUG', sep:'SEP', sept:'SEP', oct:'OCT', nov:'NOV', dec:'DEC' };
function normalizeDate(s) { if (!s) return null; const t = s.trim().replace(/\.$/, ''); const abt=t.match(/^abt\.?\s*(\d{4})/i); if (abt) return `ABT ${abt[1]}`; const dmY=t.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/); if (dmY){ const m=MONTHS[dmY[2].toLowerCase()]; if (m) return `${dmY[1]} ${m} ${dmY[3]}`;} const mY=t.match(/^([A-Za-z]{3,})\s+(\d{4})$/); if(mY){const m=MONTHS[mY[1].toLowerCase()]; if(m) return `${m} ${mY[2]}`;} const y=t.match(/(\d{4})/); if(y) return y[1]; return null; }
function splitDatePlace(s){ if(!s) return {date:null,place:null}; const idx=s.indexOf(','); if(idx===-1) return {date:normalizeDate(s),place:null}; const datePart=s.slice(0,idx).trim(); const placePart=s.slice(idx+1).trim(); return {date:normalizeDate(datePart), place: placePart||null}; }
function parsePersonLabel(label){ let name=label.trim(); let birthStr=null, deathStr=null; const bi=name.toLowerCase().indexOf(' b.'); const di=name.toLowerCase().indexOf(' d.'); if(bi!==-1 && (di===-1||bi<di)){ const rest=name.slice(bi+3).trim(); name=name.slice(0,bi).trim().replace(/,$/,''); if(rest.toLowerCase().includes(', d.')){ const di2=rest.toLowerCase().indexOf(', d.'); birthStr=rest.slice(0,di2).trim(); deathStr=rest.slice(di2+4).trim(); } else { birthStr=rest; } } else if (di!==-1){ deathStr=name.slice(di+4).trim(); name=name.slice(0,di).trim().replace(/,$/,''); } const b=splitDatePlace(birthStr); const d=splitDatePlace(deathStr); return { name, birth: b, death: d }; }

async function extractPreFromActiveTab(){
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true}); if(!tab?.id) throw new Error('No active tab');
  const frames = await chrome.scripting.executeScript({ target:{tabId:tab.id, allFrames:true}, func:()=>{ function collectFrom(root){ const rect=root.getBoundingClientRect(); const anchors=Array.from(root.querySelectorAll('a')).map(a=>{ const r=a.getBoundingClientRect(); const font=a.querySelector('font'); const color=(font?.getAttribute('color')||'').toLowerCase(); return { label:(a.textContent||'').trim(), href:a.getAttribute('href')||a.href||'', color, x: Math.round(r.left-rect.left), y: Math.round(r.top-rect.top) }; }); return { html: root.innerHTML, text: root.innerText, anchors }; }
    const pre=document.querySelector('section.response-items pre')||document.querySelector('pre');
    if(pre){ const data=collectFrom(pre); return { ok:true, ...data, frame: window.location.href } }
    const container=document.querySelector('section.response-items')||document.querySelector('.response-items')||document.body;
    if(container){ const data=collectFrom(container); return { ok:true, ...data, note:'fallback-no-pre', frame: window.location.href } }
    return { ok:false, error:'pre not found' };
  }});
  const ok=frames.find(f=>f?.result?.ok);
  if(!ok?.result?.ok) throw new Error(ok?.result?.error||'pre not found');
  return ok.result; }

function isPedigreeUrl(u){ try{ const x=new URL(u); return x.hostname==='pro.gedmatch.com' && x.pathname.includes('/tools/gedcom/pedigree-chart'); } catch { return false; } }

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
  if(Array.isArray(result.anchors)&&result.anchors.length){ anchors=result.anchors.map(a=>{ const raw=(a.label||''); const label=(raw||'').trim(); const labelNorm=label.replace(/\u00a0/g,' '); return { label, labelNorm, href:a.href||'', color:(a.color||'').toLowerCase(), x: typeof a.x==='number'?a.x:null, y: typeof a.y==='number'?a.y:null }; }); }
  else { const container=document.createElement('div'); container.innerHTML=result.html||''; anchors=Array.from(container.querySelectorAll('a')).map(a=>{ const font=a.querySelector('font'); const raw=(a.textContent||''); const label=(raw||'').trim(); const labelNorm=label.replace(/\u00a0/g,' '); return { label, labelNorm, href:a.getAttribute('href')||'', color:(font?.getAttribute('color')||'').toLowerCase(), x:null, y:null }; }); }

  function pairOutermost(lefts, rights){ const segs=[]; let li=0; let ri=rights.length-1; while(li<lefts.length && ri>=0){ const l=lefts[li]; while(ri>=0 && rights[ri]<=l) ri--; if(ri<0) break; const r=rights[ri--]; if(r>l) segs.push({ L:l, R:r, mid: Math.floor((l+r)/2) }); li++; } return segs; }

  const rows=[]; let personLines=0; let charLines=0; const personRefs=[]; // collect to quantize indents later
  const usedAnchor=new Array(anchors.length).fill(false);
  for(let i=0;i<lines.length;i++){
    const s=lines[i];
    // skip whitespace-only rows entirely
    if(!s || s.trim().length===0) continue;
    // pipe scan for every row (both person and char rows can have pipes)
    const rowPipes=[]; for(let c=0;c<s.length;c++){ if(s[c]==='|') rowPipes.push(c); }
    // detect persons from anchors on this line
    const persons=[]; const controls=[]; {
      const matchIdxs=[];
      for(let ai=0; ai<anchors.length; ai++){
        const a=anchors[ai]; const lbl=(a.labelNorm||a.label||''); if(!lbl) continue; if(s.indexOf(lbl)!==-1) matchIdxs.push(ai);
      }
      // pick the first unused matching anchor (there should be exactly one person per line)
      const chosenIdx=matchIdxs.find(ai=>!usedAnchor[ai]);
      if(chosenIdx!=null){
        const a=anchors[chosenIdx]; usedAnchor[chosenIdx]=true;
        const lbl=(a.labelNorm||a.label||'');
        let idx=s.indexOf(lbl);
        // detect navigation/expand anchors (e.g., '=>', '>>', arrows) — labels with no letters (Unicode-aware)
        const hasLetters=/\p{L}/u.test(lbl);
        const isControl = !hasLetters;
        if(isControl){
          controls.push({ kind:'expand', col: idx, label: a.label, href: resolveGedUrl(a.href||'') });
        } else {
          const parsed=parsePersonLabel(lbl);
          if(idx===-1){ const nameOnly=(parsed?.name||'').trim(); if(nameOnly){ idx=s.indexOf(nameOnly); } }
          const sex=a.color==='red'?'F':a.color==='blue'?'M':'U';
          const url=resolveGedUrl(a.href||'');
          const indentRaw=idx; const px=a.x;
          const rec={ label:lbl, name:parsed.name, birth:parsed.birth, death:parsed.death, sex, url, col:idx, indentRaw, px, indent:null, leadingSpaces:(s.match(/^\s*/)||[''])[0].length };
          persons.push(rec); personRefs.push({ line:i, ref:rec });
        }
      }
    }
    if(persons.length){
      rows.push({ idx:i, type:'person', persons, text:s, pipes: rowPipes, pipeCount: rowPipes.length, controls }); personLines++; continue;
    }
    // char row tokens
    const pipes=[]; const lefts=[]; const rights=[]; for(let c=0;c<s.length;c++){ const ch=s[c]; if(ch==='|') pipes.push(c); else if(ch==='/') lefts.push(c); else if(ch==='\\') rights.push(c); }
    const segments=pairOutermost(lefts, rights);
    if(pipes.length || lefts.length || rights.length || controls.length){ rows.push({ idx:i, type:'char', pipes, pipeCount: pipes.length, lefts, rights, segments, text:s, controls }); charLines++; }
  }
  // Quantize person indents to discrete levels using label column (fallback to pixel x if helpful)
  const cols=personRefs.map(r=>r.ref.col).sort((a,b)=>a-b);
  const uniqueCols=[...new Set(cols)];
  let minCol=uniqueCols.length?uniqueCols[0]:0;
  let step=0;
  for(let i=1;i<uniqueCols.length;i++){ const d=uniqueCols[i]-uniqueCols[i-1]; if(d>0 && (step===0 || d<step)) step=d; }
  if(!step || step<2){ step=4; }
  for(const pr of personRefs){ pr.ref.indent=Math.max(0, Math.round((pr.ref.col - minCol)/step)); }
  return { totalLines: lines.length, personLines, charLines, indentBase:minCol, indentStep:step, rows };
}

// V9: Strict, position-based graph -> families using revised GROK rules
function buildFamiliesFromRowsV9(rowsJson){
  const logs=[];
  const rows=rowsJson?.rows||[];
  const indentStep = Number(rowsJson?.indentStep ?? 6);
  const OFFSET = Math.max(1, Math.floor(indentStep/2));
  const TOL = 3;

  // Build people list and row mappings
  const people=[]; const rowToId=new Map(); const idxToRowIndex=new Map();
  for(let i=0;i<rows.length;i++){ idxToRowIndex.set(rows[i].idx, i); }
  for(const r of rows){
    if(r.type==='person' && Array.isArray(r.persons) && r.persons.length){
      const pr=r.persons[0];
      const id=people.length;
      people.push({ id, name:(pr.name||'').trim(), originalName:(pr.name||'').trim(), sex:(pr.sex||'U').toUpperCase(), birth:pr.birth||null, death:pr.death||null, url:pr.url||'', indent:Number(pr.indent||0), col:Number(pr.col||0), label:(pr.label||'').trim(), line:r.idx, parents:[], children:[], spouse:null });
      rowToId.set(r.idx, id);
    }
  }

  // Helpers to find nearest person row above/below given array index
  function personIdAbove(arrayIdx){ for(let k=arrayIdx-1;k>=0;k--){ const rr=rows[k]; if(rr.type==='person' && rowToId.has(rr.idx)) return rowToId.get(rr.idx); } return null; }
  function personIdBelow(arrayIdx){ for(let k=arrayIdx+1;k<rows.length;k++){ const rr=rows[k]; if(rr.type==='person' && rowToId.has(rr.idx)) return rowToId.get(rr.idx); } return null; }
  function addEdge(childId,parentId){ if(childId==null||parentId==null) return; if(!people[childId].parents.includes(parentId)) people[childId].parents.push(parentId); if(!people[parentId].children.includes(childId)) people[parentId].children.push(childId); }
  function matchAt(pid, col){ if(pid==null) return false; return Math.abs((people[pid].col||0) - col) <= TOL; }

  // Trace continuity along a column until next person row appears
  function traceDownFromChar(charArrIdx, startCol){
    let col=startCol; let window=null; // [L,R] when inside a segment span
    for(let k=charArrIdx+1; k<rows.length; k++){
      const rr=rows[k];
      if(rr.type==='char'){
        // If inside a segment, keep window and allow span; else require pipe continuity
        const seg=(rr.segments||[]).find(s=> s.L<=col && col<=s.R);
        if(seg){ window=[seg.L, seg.R]; continue; }
        // Diagonal shift across nearby slashes
        let shifted=false; if((rr.rights||[]).some(rp=>Math.abs(rp-col)<=3)){ const R=(rr.rights||[]).reduce((b,v)=> Math.abs(v-col)<Math.abs(b-col)?v:b, rr.rights[0]); const mid=Math.floor((col+R)/2); col = mid + OFFSET; shifted=true; }
        if((rr.lefts||[]).some(lp=>Math.abs(lp-col)<=3)){ const L=(rr.lefts||[]).reduce((b,v)=> Math.abs(v-col)<Math.abs(b-col)?v:b, rr.lefts[0]); const mid=Math.floor((col+L)/2); col = mid - OFFSET; shifted=true; }
        if(shifted) { window=null; continue; }
        const hasPipe=(rr.pipes||[]).some(p=>Math.abs(p-col)<=3);
        if(hasPipe) continue;
        // if we had a window previously but no new coverage, keep pipe requirement
        return null;
      } else if(rr.type==='person'){
        const pid=rowToId.get(rr.idx);
        if(window){ const pc=people[pid].col||0; if(pc>=window[0]-TOL && pc<=window[1]+TOL) return pid; }
        if(matchAt(pid,col)) return pid;
        // pass-through if person row has a nearby pipe, or if the next char row below spans this col
        const personPipes=(rr.pipes||[]); if(personPipes.some(p=>Math.abs(p-col)<=3)) continue;
        const next=rows[k+1]; if(next && next.type==='char'){ const seg2=(next.segments||[]).find(s=> s.L<=col && col<=s.R); if(seg2){ window=[seg2.L, seg2.R]; k++; continue; } }
        return null;
      }
    }
    return null;
  }
  function traceUpFromChar(charArrIdx, startCol){
    let col=startCol; let window=null;
    for(let k=charArrIdx-1; k>=0; k--){
      const rr=rows[k];
      if(rr.type==='char'){
        const seg=(rr.segments||[]).find(s=> s.L<=col && col<=s.R);
        if(seg){ window=[seg.L, seg.R]; continue; }
        // Diagonal shift across nearby slashes
        let shifted=false; if((rr.rights||[]).some(rp=>Math.abs(rp-col)<=3)){ const R=(rr.rights||[]).reduce((b,v)=> Math.abs(v-col)<Math.abs(b-col)?v:b, rr.rights[0]); const mid=Math.floor((col+R)/2); col = mid - OFFSET; shifted=true; }
        if((rr.lefts||[]).some(lp=>Math.abs(lp-col)<=3)){ const L=(rr.lefts||[]).reduce((b,v)=> Math.abs(v-col)<Math.abs(b-col)?v:b, rr.lefts[0]); const mid=Math.floor((col+L)/2); col = mid + OFFSET; shifted=true; }
        if(shifted) { window=null; continue; }
        const hasPipe=(rr.pipes||[]).some(p=>Math.abs(p-col)<=3);
        if(hasPipe) continue;
        return null;
      } else if(rr.type==='person'){
        const pid=rowToId.get(rr.idx);
        if(window){ const pc=people[pid].col||0; if(pc>=window[0]-TOL && pc<=window[1]+TOL) return pid; }
        if(matchAt(pid,col)) return pid;
        const personPipes=(rr.pipes||[]); if(personPipes.some(p=>Math.abs(p-col)<=3)) continue; // pass-through person with pipe
        const prev=rows[k-1]; if(prev && prev.type==='char'){ const seg2=(prev.segments||[]).find(s=> s.L<=col && col<=s.R); if(seg2){ window=[seg2.L, seg2.R]; k--; continue; } }
        return null;
      }
    }
    return null;
  }

  // Process connector rows bottom-up (with deep pipe bridging)
  for(let i=0;i<rows.length;i++){
    const r=rows[i]; if(r.type!=='char') continue; const txt=r.text||'';
    const upId=personIdAbove(i); const dnId=personIdBelow(i);
    // Segments (paired / and \)
    if((Array.isArray(r.segments) && r.segments.length) || ((r.lefts?.length||0) && (r.rights?.length||0))){
      const segPairs=[]; const seen=new Set();
      const addPair=(L,R,ch)=>{ const key=L+":"+R+":"+ch; if(seen.has(key)) return; seen.add(key); segPairs.push({ L:Number(L), R:Number(R), mid:Math.floor((Number(L)+Number(R))/2), ch }); };
      if(Array.isArray(r.segments) && r.segments.length){
        for(const seg of r.segments){ const L=Number(seg.L), R=Number(seg.R); const ch=txt.charAt(L)||'/'; const key=L+":"+R+":"+ch; if(!seen.has(key)) { seen.add(key); segPairs.push({ L, R, mid:Number(seg.mid), ch }); } }
      }
      // Build pairs even when one side precedes the other
      const lefts=(r.lefts||[]).map(Number); const rights=(r.rights||[]).map(Number);
      // Standard: for each '/' at L, pair with nearest '\\' to the right
      for(const L of lefts){ let bestR=null, best=1e9; for(const R of rights){ if(R>L && (R-L)<best){ best=R-L; bestR=R; } } if(bestR!=null) addPair(L,bestR,'/'); }
      // Reversed: for each '\\' at R (in rights array), pair with nearest '/' to the right
      for(const R of rights){ let bestL=null, best=1e9; for(const L of lefts){ if(L>R && (L-R)<best){ best=L-R; bestL=L; } } if(bestL!=null) addPair(bestL,R,'\\'); }
      for(const pair of segPairs){
        const parentCol=pair.mid + OFFSET; const childCol=pair.mid - OFFSET;
        // Try up-orientation first (parents above, child below)
        let upParent=traceUpFromChar(i,parentCol); let downChild=traceDownFromChar(i,childCol);
        let added=false;
        if(upParent!=null && downChild!=null){ addEdge(downChild, upParent); added=true; }
        if(!added){
          // Try down-orientation (parent below, child above)
          const downParent=traceDownFromChar(i,parentCol); const upChild=traceUpFromChar(i,childCol);
          if(downParent!=null && upChild!=null){ addEdge(upChild, downParent); added=true; }
        }
      }
    }
    // Single slashes
    else {
      if((r.lefts||[]).length && !(r.rights||[]).length){
        for(const L of r.lefts){ const parent=traceUpFromChar(i, Number(L)+OFFSET); const child=traceDownFromChar(i, Number(L)-OFFSET); if(parent!=null && child!=null) addEdge(child,parent); }
      }
      if((r.rights||[]).length && !(r.lefts||[]).length){
        for(const R of r.rights){ const parent=traceDownFromChar(i, Number(R)+OFFSET); const child=traceUpFromChar(i, Number(R)-OFFSET); if(parent!=null && child!=null) addEdge(child,parent); }
      }
    }
    // Pipes: connect across very long stacks by following the lane up to first person and down to last person
    for(const P of (r.pipes||[])){
      // Extend upwards until a person or break
      let upChar=i; let topPerson=null; let guard=0;
      while(upChar>=0 && guard++<100){ const res=traceUpFromChar(upChar, P); const prevChar=upChar-1; if(res!=null){ topPerson=res; break; } if(prevChar<0 || rows[prevChar].type!=='char') break; const hasPipe=(rows[prevChar].pipes||[]).some(pp=>Math.abs(pp-P)<=3); const seg=(rows[prevChar].segments||[]).some(s=>s.L<=P && P<=s.R); if(!(hasPipe||seg)) break; upChar=prevChar; }
      // Extend downwards until a person or break
      let downChar=i; let bottomPerson=null; guard=0;
      while(downChar<rows.length && guard++<100){ const res=traceDownFromChar(downChar, P); const nextChar=downChar+1; if(res!=null){ bottomPerson=res; break; } if(nextChar>=rows.length || rows[nextChar].type!=='char') break; const hasPipe=(rows[nextChar].pipes||[]).some(pp=>Math.abs(pp-P)<=3); const seg=(rows[nextChar].segments||[]).some(s=>s.L<=P && P<=s.R); if(!(hasPipe||seg)) break; downChar=nextChar; }
      if(topPerson!=null && bottomPerson!=null){ if(people[topPerson].indent>people[bottomPerson].indent) addEdge(bottomPerson, topPerson); else addEdge(topPerson, bottomPerson); }
    }
  }

  // Phase 1: normalize child->parents (max two parents, choose by proximity)
  for(const child of people){ if(!Array.isArray(child.parents)) child.parents=[]; if(child.parents.length<=2) continue;
    // sort candidate parents by (indent desc, column proximity)
    const sorted=child.parents.slice().sort((aId,bId)=>{
      const a=people[aId], b=people[bId];
      const indentCmp=(b.indent - a.indent);
      if(indentCmp!==0) return indentCmp; const da=Math.abs((a.col||0) - (child.col||0)); const db=Math.abs((b.col||0) - (child.col||0));
      return da - db;
    });
    const keep=new Set(sorted.slice(0,2));
    child.parents = sorted.slice(0,2);
    // remove back-links from dropped parents
    for(const pid of sorted.slice(2)){ const idx=(people[pid].children||[]).indexOf(child.id); if(idx>=0) people[pid].children.splice(idx,1); }
  }

  // Phase 2: derive families strictly from child parent-sets
  const parentSetToChildren=new Map(); // key: parent ids sorted joined by '|'
  for(const child of people){ const parents=(child.parents||[]).slice(0,2);
    const sortedParents=parents.slice().sort((a,b)=>a-b);
    const key=sortedParents.join('|');
    if(!parentSetToChildren.has(key)) parentSetToChildren.set(key, new Set());
    parentSetToChildren.get(key).add(child.id);
  }

  // Phase 3: infer spouses from two-parent families only; avoid adjacency guesses
  const spouseOf=new Map();
  for(const [key, kids] of parentSetToChildren.entries()){
    const ids=key.length? key.split('|').map(Number) : [];
    if(ids.length===2){ const [a,b]=ids; spouseOf.set(a,b); spouseOf.set(b,a); }
  }

  // Phase 4: materialize families from parent-set groups
  const families=[];
  for(const [key, kids] of parentSetToChildren.entries()){
    const ids=key.length? key.split('|').map(Number) : [];
    // if key is empty (child with no detected parents), skip family creation
    if(ids.length===0) continue;
    families.push({ parents: ids.slice(0,2), children: Array.from(kids) });
  }

  logs.push({ type:'v9-summary', people: people.length, families: families.length });
  return { people, families, logs };
}

// V8: From-scratch builder using clean rows JSON (segments, slashes, pipes)
function buildFamiliesFromRowsV8(rowsJson){
  const logs=[];
  const rows=rowsJson?.rows||[];
  const people=[]; const rowToPid=new Map(); const personRows=[]; const charRows=[];
  for(const r of rows){
    if(r.type==='person' && Array.isArray(r.persons) && r.persons.length){
      const pr=r.persons[0]; const id=people.length;
      people.push({ id, name: pr.name||'Unknown', sex: pr.sex||'U', birth: pr.birth||null, death: pr.death||null, url: pr.url||'', indent: pr.indent??0, col: pr.col||0, label: pr.label||'', line: r.idx });
      rowToPid.set(r.idx, id); personRows.push(r);
    } else if(r.type==='char') { charRows.push(r); }
  }

  // helpers
  const tolCol=28;
  function nearPid(pid, col){ if(pid==null) return false; const pc=people[pid].col||0; return Math.abs(pc-col)<=tolCol; }
  function width(pid){ const lbl=people[pid].label||''; return Math.max(10, Math.min(60, lbl.length)); }
  function addEdge(childId, parentId){ if(childId==null||parentId==null) return; edgesChildToParents.get(childId)?.add(parentId) || edgesChildToParents.set(childId, new Set([parentId])); childrenOf.get(parentId)?.add(childId) || childrenOf.set(parentId, new Set([childId])); }

  const edgesChildToParents=new Map(); // childId -> Set(parentId)
  const childrenOf=new Map(); // parentId -> Set(childId)

  // Trace pipes: connect above to below when aligned
  for(const r of charRows){ const above=rowToPid.get(r.idx-1); const below=rowToPid.get(r.idx+1); if(above!=null && below!=null){ for(const p of (r.pipes||[])){ if(nearPid(above,p) && nearPid(below,p)) addEdge(below, above); } } }

  // Handle segments and single slashes
  for(const r of charRows){ if(r.controls?.length) continue; const above=rowToPid.get(r.idx-1); const below=rowToPid.get(r.idx+1); const txt=r.text||'';
    if((r.segments||[]).length){
      for(let si=0; si<r.segments.length; si++){
        const seg=r.segments[si]; const L=seg.L, R=seg.R, mid=seg.mid;
        const slashChar=txt[L]||'/';
        if(slashChar==='/'){
          const parent= (above!=null && (nearPid(above,R) || (Math.abs((people[above].col||0)-(R))<=width(above)))) ? above : null;
          const child= (below!=null && nearPid(below,L)) ? below : null;
          if(parent!=null && child!=null) addEdge(child,parent);
        } else if(slashChar==='\\'){
          const parent= (below!=null && (nearPid(below,R) || (Math.abs((people[below].col||0)-R)<=width(below)))) ? below : null;
          const child= (above!=null && nearPid(above,L)) ? above : null;
          if(parent!=null && child!=null) addEdge(child,parent);
        }
      }
    } else {
      // single slash rows
      if((r.lefts||[]).length && !(r.rights||[]).length){
        for(const L of r.lefts){ const ch=txt[L]; if(ch!=='/') continue; const parent=above!=null?above:null; const child=below!=null?below:null; if(parent!=null && child!=null && (nearPid(parent,L+2) || nearPid(parent,L)) && nearPid(child,L-2)) addEdge(child,parent); }
      }
      if((r.rights||[]).length && !(r.lefts||[]).length){
        for(const R of r.rights){ const ch='\\'; const parent=below!=null?below:null; const child=above!=null?above:null; if(parent!=null && child!=null && (nearPid(parent,R+2) || nearPid(parent,R)) && nearPid(child,R-2)) addEdge(child,parent); }
      }
    }
  }

  // Build spouse inference (same indent, close cols or shared child)
  const spouseOf=new Map();
  const sorted=people.slice().sort((a,b)=> a.indent!==b.indent ? b.indent-a.indent : a.col-b.col);
  for(let i=0;i<sorted.length-1;i++){
    const a=sorted[i], b=sorted[i+1];
    if(a.indent===b.indent && Math.abs(a.col-b.col)<60 && !spouseOf.has(a.id) && !spouseOf.has(b.id)){
      // prefer differing sex if available
      if(a.sex!==b.sex || a.sex==='U' || b.sex==='U'){ spouseOf.set(a.id,b.id); spouseOf.set(b.id,a.id); }
    }
  }

  // Build families from edges and spouses
  const families=[]; const famKeySet=new Set();
  function pushFamily(parents, children){ const key=parents.slice().sort((x,y)=>x-y).join('|'); if(!famKeySet.has(key)){ famKeySet.add(key); families.push({ parents: parents.slice(0,2), children: Array.from(children||[]) }); } else { const fam=families.find(f=>f.parents.slice().sort((x,y)=>x-y).join('|')===key); for(const c of (children||[])) if(!fam.children.includes(c)) fam.children.push(c); }
  }

  // spouse-based grouping with children union
  for(const p of people){ const s=spouseOf.get(p.id); if(s!=null && p.id<s){ const kids=new Set([...(childrenOf.get(p.id)||[]), ...(childrenOf.get(s)||[])]); pushFamily([p.id,s], kids); } }
  // single-parent families
  for(const [parentId,kids] of childrenOf.entries()){ if(!spouseOf.has(parentId)) pushFamily([parentId], kids); }

  logs.push({ type:'v8-summary', people: people.length, families: families.length });
  return { people, families, logs };
}

// Construct people and families from intermediary rows JSON - fixed algorithm
function buildFamiliesFromRows(rowsJson){
  const logs=[];
  const rows=rowsJson?.rows||[];
  
  // Build people array and row->person map
  const people=[]; const rowToPid=new Map(); const personRows=[];
  rows.forEach(r=>{ if(r.type==='person' && Array.isArray(r.persons) && r.persons.length){ const p=r.persons[0]; const id=people.length; people.push({ id, sex:p.sex||'U', url:p.url||'', name:p.name||'Unknown', birth:p.birth||null, death:p.death||null, line:r.idx, col: p.col||0, indent: typeof p.indent==='number'?p.indent:0 }); rowToPid.set(r.idx, id); personRows.push(r); }});

  // Helper to find person at specific row
  function personAtRow(rowIdx){ return rowToPid.get(rowIdx) ?? null; }
  
  // Helper to find nearest person above/below by column
  const tolCol=30;
  function nearestPersonAbove(rowIdx, col){ let best=null, bestd=1e9; for(const r of personRows){ if(r.idx>=rowIdx) continue; const pid=rowToPid.get(r.idx); const pcol=(r.persons[0]||{}).col||0; const d=Math.abs(pcol-col); if(d<bestd){ best=pid; bestd=d; } } return (bestd<=tolCol)?best:null; }
  function nearestPersonBelow(rowIdx, col){ let best=null, bestd=1e9; for(const r of personRows){ if(r.idx<=rowIdx) continue; const pid=rowToPid.get(r.idx); const pcol=(r.persons[0]||{}).col||0; const d=Math.abs(pcol-col); if(d<bestd){ best=pid; bestd=d; } } return (bestd<=tolCol)?best:null; }

  // Build families using pipe-enforced approach
  const families=[];
  const famKey=(p1,p2)=>{ const ps=[p1,p2].filter(x=>x!=null).sort((a,b)=>a-b); return ps.join('|'); };
  const famMap=new Map();
  
  // Precompute active pipe columns per char row (state machine)
  const charRows=rows.filter(r=>r.type==='char');
  const charIdxToActive=new Map();
  for(let k=0;k<charRows.length;k++){
    const r=charRows[k]; const prev=charRows[k-1];
    const active=new Set();
    // carry pipes
    for(const c of (r.pipes||[])) active.add(c);
    // carry over from prev via continuity
    if(prev){
      const prevActive=charIdxToActive.get(prev.idx)||new Set();
      for(const c of prevActive){
        // keep if a pipe at same col, or if inside any L/R segment on this row
        const hasPipe=(r.pipes||[]).some(x=>Math.abs(x-c)<=0);
        const covered=(r.segments||[]).some(seg=>seg.L<c && c<seg.R);
        if(hasPipe || covered) active.add(c);
      }
    }
    charIdxToActive.set(r.idx, active);
  }

  // Process each char row with pipe validation
  for(let i=0; i<rows.length; i++){
    const r=rows[i];
    if(r.type!=='char') continue;
    if(r.controls?.length) continue; // skip control-only rows (expand arrows)
    const active=charIdxToActive.get(r.idx)||new Set();
    
    // If child immediately above
    if(i>0 && rows[i-1].type==='person'){
      const childId=personAtRow(rows[i-1].idx); const child=people[childId];
      let leftParent=null, rightParent=null;
      if((r.lefts||[]).length){ leftParent=nearestPersonAbove(i, r.lefts[0]); }
      if((r.rights||[]).length){ rightParent=nearestPersonBelow(i, r.rights[(r.rights.length-1)]); }
      const parents=[leftParent, rightParent].filter(x=>x!=null);
      if(parents.length){ const key=famKey(parents[0], parents[1]); if(!famMap.has(key)){ famMap.set(key,{ parents:parents.slice(0,2), children:[] }); families.push(famMap.get(key)); } const fam=famMap.get(key); if(!fam.children.includes(childId)) fam.children.push(childId); logs.push({ type:'child-above-row', row:i, child:childId, parents }); }
      continue;
    }

    // Check for segments (marriage junctions)
    if(r.segments && r.segments.length){
      for(const seg of r.segments){
        // require a child reachable via the midpoint pipe
        const child=findChildViaPipe(i, seg.mid);
        if(child==null){ logs.push({ type:'skip-seg-no-child', row:i, seg }); continue; }
        // Check if there's a person immediately above (parent1)
        const abovePerson = (i>0 && rows[i-1].type==='person') ? personAtRow(rows[i-1].idx) : null;
        // Check if there's a person immediately below (child or parent2)
        const belowPerson = (i<rows.length-1 && rows[i+1].type==='person') ? personAtRow(rows[i+1].idx) : null;
        
        if(abovePerson!=null && belowPerson!=null){
          // This is likely parent-spouse junction
          const leftParent = abovePerson;
          const rightParent = belowPerson;
          if(child!=null && child!==belowPerson){
            const key=famKey(leftParent,rightParent);
            if(!famMap.has(key)){ famMap.set(key,{ parents:[leftParent,rightParent], children:[] }); families.push(famMap.get(key)); }
            const fam=famMap.get(key);
            if(!fam.children.includes(child)) fam.children.push(child);
            logs.push({ type:'marriage-junction', row:i, leftParent, rightParent, child });
          }
        } else {
          // Standard junction: parents above, child below
          const pL = nearestPersonAbove(i, seg.L);
          const pR = nearestPersonAbove(i, seg.R);
          if(child!=null && (pL!=null || pR!=null)){
            const key=famKey(pL,pR);
            if(!famMap.has(key)){ famMap.set(key,{ parents:[pL,pR].filter(x=>x!=null), children:[] }); families.push(famMap.get(key)); }
            const fam=famMap.get(key);
            if(!fam.children.includes(child)) fam.children.push(child);
            logs.push({ type:'standard-junction', row:i, parents:[pL,pR].filter(x=>x!=null), child });
          }
        }
      }
    }
    // Single slash cases
    else if((r.lefts||[]).length && !(r.rights||[]).length){
      for(const c of r.lefts){
        const child=nearestPersonBelow(i,c);
        const parent=nearestPersonAbove(i,c);
        if(parent!=null && child!=null){
          const key=famKey(parent,null);
          if(!famMap.has(key)){ famMap.set(key,{ parents:[parent], children:[] }); families.push(famMap.get(key)); }
          const fam=famMap.get(key);
          if(!fam.children.includes(child)) fam.children.push(child);
          logs.push({ type:'single-left', row:i, parent, child });
        }
      }
    }
    else if((r.rights||[]).length && !(r.lefts||[]).length){
      for(const c of r.rights){
        const child=(i>0 && rows[i-1].type==='person')? personAtRow(rows[i-1].idx) : nearestPersonAbove(i,c);
        const parent=nearestPersonBelow(i,c);
        if(parent!=null && child!=null){
          const key=famKey(parent,null);
          if(!famMap.has(key)){ famMap.set(key,{ parents:[parent], children:[] }); families.push(famMap.get(key)); }
          const fam=famMap.get(key);
          if(!fam.children.includes(child)) fam.children.push(child);
          logs.push({ type:'single-right', row:i, parent, child });
        }
      }
    }
  }
  
  logs.push({ type:'summary', people: people.length, families: families.length });
  return { people, families, logs };
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

async function buildGedcom(people, meta, families){
  // Identify root as the person with the minimum indent in the parsed tree
  let rootIdx=-1; let minIndent=Number.POSITIVE_INFINITY;
  for(let i=0;i<people.length;i++){ const ind=Number(people[i].indent||0); if(ind<minIndent){ minIndent=ind; rootIdx=i; } }
  // Inject root (level 0) name from CSV kit when available
  try {
    const kitName=(meta?.rootName||'').trim();
    if(kitName && rootIdx>=0){
      const formatted=(function formatGedcomNameFromKit(raw){
        const s=(raw||'').trim(); if(!s) return '';
        if(s.startsWith('*')){ return s.replace(/^\*/,'').trim(); }
        const tokens=s.split(/\s+/).filter(Boolean);
        if(tokens.length===1) return tokens[0];
        const surname=tokens[tokens.length-1];
        const given=tokens.slice(0,-1).join(' ');
        return `${given} /${surname}/`;
      })(kitName);
      if(formatted){ people[rootIdx].name=formatted; }
    }
  } catch(_){ }
  const now=new Date(); const yyyy=now.getFullYear(); const mm=String(now.getMonth()+1).padStart(2,'0'); const dd=String(now.getDate()).padStart(2,'0');
  const head=[ '0 HEAD','1 SOUR GedMapper','2 NAME GedMapper GEDmatch Capture','2 VERS 0.1','1 DATE '+`${yyyy}-${mm}-${dd}`,'1 SUBM @SUB1@','1 GEDC','2 VERS 5.5.1','2 FORM LINEAGE-LINKED','1 CHAR UTF-8' ]; if(meta?.kit) head.push('1 _OM_REFERENCE_KIT '+meta.kit);
  const subm=[ '0 @SUB1@ SUBM','1 NAME GEDmatch Importer User' ];
  const indiPtr = (i)=>`@I${i+1}@`; // index based on array order
  // Load segments index once
  let segIndex=null; try{ const store=await chrome.storage.local.get(['gmSegmentsData']); const segs=store.gmSegmentsData?.segments||[]; segIndex=buildSegmentsIndex(segs); } catch(_e){ segIndex=null; }
  // Build kit -> email map from autosomal CSV
  let emailByKit=new Map();
  try{ const all=(await chrome.storage.local.get(['gmAllCsvRecords'])).gmAllCsvRecords||[]; for(const r of all){ if(r?.Kit && r?.Email) emailByKit.set(r.Kit, r.Email); } } catch(_e){}

  const blocks = await Promise.all(people.map(async (p,i)=>{ const lines=[`0 ${indiPtr(i)} INDI`, `1 NAME ${p.name || 'Unknown'}`, `1 SEX ${p.sex || 'U'}`]; if(p.birth?.date || p.birth?.place){ lines.push('1 BIRT'); if(p.birth.date) lines.push(`2 DATE ${p.birth.date}`); if(p.birth.place) lines.push(`2 PLAC ${p.birth.place}`);} if(p.death?.date || p.death?.place){ lines.push('1 DEAT'); if(p.death.date) lines.push(`2 DATE ${p.death.date}`); if(p.death.place) lines.push(`2 PLAC ${p.death.place}`);} if(p.url) lines.push(`1 _OM_SOURCE_URL ${p.url}`); if(i===rootIdx && (meta?.rootName)){ lines.push(`1 NOTE _OM_NAME_SOURCE gedmatch-csv`); lines.push(`1 NOTE Root name inferred from kit CSV: ${String(meta.rootName).trim()}`); lines.push('1 NOTE Root individual inferred from GEDmatch pedigree'); } if(i===rootIdx && meta?.atdnaTotal){ const val=String(meta.atdnaTotal).trim(); if(val) lines.push(`1 _OM_ATDNA ${val}`); } if(i===rootIdx && meta?.kit){ lines.push('1 _OM_DNA_SOURCE'); lines.push(`2 _OM_KIT_ID ${meta.kit}`); lines.push('2 _OM_KIT_SITE GEDMATCH'); const em=emailByKit.get(meta.kit); if(em) lines.push(`2 _OM_SUBMITTER_EMAIL ${em}`); }
    // Segment data: if this individual's CSV kit is known, append any segments
    const kitId = (i===rootIdx ? (meta?.kit||'') : '');
    if(kitId && segIndex && segIndex.has(kitId)){
      lines.push(...emitSegmentLinesForKit(kitId, segIndex.get(kitId)));
    }
    return { lines, fLinks: [] }; }));
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
  const segFileInput = document.getElementById('segCsvFile');

  fileInput.addEventListener('change', async () => { const file=fileInput.files[0]; if(!file) return; try { const text=await file.text(); await chrome.storage.local.set({ gmPendingCsvText:text, gmGedmatchPendingMeta:{ name:file.name, size:file.size, lastModified:file.lastModified } }); updateStats(state.session.profiles, `Pending: ${file.name}`);} catch(e){ updateStats(state.session.profiles,'Failed to read file'); }});

  segFileInput.addEventListener('change', async () => { const file=segFileInput.files[0]; if(!file) return; try { const text=await file.text(); const built=buildSegmentsFromText(text); await chrome.storage.local.set({ gmSegmentsCsvMeta:{ name:file.name, size:file.size, lastModified:file.lastModified }, gmSegmentsData: built }); const kits=(built?.kits||[]).length; const el=document.getElementById('segStats'); if(el) el.textContent=`Segments: ${kits} kits`; } catch(e){ const el=document.getElementById('segStats'); if(el) el.textContent='Segments: failed to read'; } });

  document.getElementById('parseBtn').onclick = async () => { const s=await getState(); if(!s.pendingText){ updateStats(s.session.profiles,'No pending file'); return;} const built=buildSessionFromText(s.pendingText); if(built.error){ updateStats([],built.error); return;} await saveSession(built.session); await chrome.storage.local.set({ gmAllCsvRecords: built.allRecords||[] }); const statusByKit=(await getState()).statusByKit; for(const p of built.session.profiles) if(!statusByKit[p.Kit]) statusByKit[p.Kit]='red'; await saveStatusMap(statusByKit); renderList(built.session.profiles,statusByKit); updateStats(built.session.profiles, s.pendingMeta?.name?`Loaded: ${s.pendingMeta.name}`:undefined); chrome.storage.local.remove(['gmPendingCsvText','gmGedmatchPendingMeta']); };

  document.getElementById('segParseBtn').onclick = async () => { try { const store=await chrome.storage.local.get(['gmSegmentsData','gmSegmentsCsvMeta']); const kits=(store.gmSegmentsData?.kits||[]).length||0; const el=document.getElementById('segStats'); if(el) el.textContent=`Segments: ${kits} kits${store.gmSegmentsCsvMeta?.name?` • ${store.gmSegmentsCsvMeta.name}`:''}`; } catch(e){} };

  document.getElementById('clearSession').onclick = async () => { if(!confirm('This will permanently clear the loaded CSV, parsed list, statuses, and pending data. Continue?')) return; await chrome.storage.local.remove(['gmGedmatchSession','gmGedmatchPendingMeta','gmPendingCsvText','gmStatusByKit','gmFocusedKit','gmCapturedByKit','gmLogsByKit']); document.getElementById('rows').innerHTML=''; document.getElementById('currentBox').classList.add('hidden'); updateStats([],'Cleared'); };

  document.getElementById('btnCapture').onclick = async () => { const st=await getState(); const kit=st.focusedKit; if(!kit){ alert('No focused individual. Click Open on a row first.'); return;} try { const pre=await extractPreFromActiveTab(); if(!isPedigreeUrl(pre?.frame||'')){ alert('Not on a GEDmatch pedigree page. Navigate to a /tools/gedcom/pedigree-chart page first.'); return; } const rowsJson=buildIntermediaryRows(pre); const built=buildFamiliesFromRowsV9(rowsJson); const profile=st.session.profiles.find(x=>x.Kit===kit); const gedcom=await buildGedcom(built.people,{ kit, rootName: profile?.Name||'', atdnaTotal: profile?.AtdnaTotal||'' }, built.families); await saveCapture(kit,{ rowsJson, gedcom, count: built.people.length, families: built.families.length, capturedAt:new Date().toISOString(), sourceUrl: pre?.frame||profile?.treeUrl||'' }, built.logs); const statusByKit=st.statusByKit; statusByKit[kit]='yellow'; await saveStatusMap(statusByKit); setCurrentBox(profile,'yellow'); refreshStatusDots(st.session.profiles,statusByKit); updateStats(st.session.profiles, `Captured ${built.people.length} people, ${built.families.length} families`);} catch(e){ console.error('Capture failed',e); alert('Capture failed: '+(e?.message||e)); } };

  document.getElementById('btnFinalize').onclick = async () => { const st=await getState(); const kit=st.focusedKit; if(!kit) return; const statusByKit=st.statusByKit; statusByKit[kit]='green'; await saveStatusMap(statusByKit); const profile=st.session.profiles.find(x=>x.Kit===kit); setCurrentBox(profile,'green'); refreshStatusDots(st.session.profiles,statusByKit); };

  document.getElementById('btnClearCopy').onclick = async () => { const st=await getState(); const kit=st.focusedKit; if(!kit) return; const store=await chrome.storage.local.get(['gmCapturedByKit']); const cap=store.gmCapturedByKit||{}; delete cap[kit]; await chrome.storage.local.set({ gmCapturedByKit: cap }); const statusByKit=st.statusByKit; statusByKit[kit]='red'; await saveStatusMap(statusByKit); const profile=st.session.profiles.find(x=>x.Kit===kit); setCurrentBox(profile,'red'); refreshStatusDots(st.session.profiles,statusByKit); };

  document.getElementById('btnCaptureSub').onclick = () => { alert('Capture Subtree: coming soon'); };

  // Auto-capture all detected tree links for the focused kit
  document.getElementById('btnGetAllTrees').onclick = async () => {
    const st=await getState(); const kit=st.focusedKit; if(!kit){ alert('No focused individual.'); return; }
    const session=(await getState()).session; const p=session.profiles.find(x=>x.Kit===kit); const trees=(p?.__trees||[]);
    if(!trees.length){ alert('No tree list detected for this kit yet. Open the kit link first.'); return; }
    let captured=0; for(const t of trees){
      try{
        const tab=await chrome.tabs.create({ url:t.pedigreeUrl, active:false });
        await new Promise(r=>setTimeout(r, 800));
        const pre=await extractPreFromActiveTab(); // operates on active tab; switch
        await chrome.tabs.update(tab.id, { active:true });
        const rowsJson=buildIntermediaryRows(pre);
        const built=buildFamiliesFromRowsV9(rowsJson);
        const profile=session.profiles.find(x=>x.Kit===kit);
      const gedcom=await buildGedcom(built.people,{ kit, rootName: profile?.Name||'', atdnaTotal: profile?.AtdnaTotal||'' }, built.families);
        await saveCapture(kit,{ rowsJson, gedcom, count: built.people.length, families: built.families.length, capturedAt:new Date().toISOString(), sourceUrl: t.pedigreeUrl }, built.logs);
        captured++;
        await chrome.tabs.remove(tab.id);
      } catch(e){ console.error('Auto capture failed', e); }
    }
    alert(`Auto-captured ${captured}/${trees.length} trees`);
  };

  // Auto run across the entire CSV: for each profile, open its kit URL, let content.js pick first tree, capture, and move on
  document.getElementById('autoAllCsv').onclick = async () => {
    const st=await getState(); const profiles=st.session.profiles||[]; if(!profiles.length){ alert('No profiles loaded.'); return; }
    let completed=0; for(const p of profiles){ try{
      // open the kit URL and allow our content.js to auto-navigate to pedigree
      if(!p.treeUrl) continue; const tab=await chrome.tabs.create({ url:p.treeUrl, active:true });
      await navLog(p.Kit,{ step:'auto-all-opened', url:p.treeUrl });
      const loaded=await waitForTabComplete(tab.id); await navLog(p.Kit,{ step:'auto-all-tab-complete', loaded });
      // give the content script time to jump to pedigree
      await new Promise(r=>setTimeout(r, 800));
      const preInfo=await extractPreFromActiveTab(); if(!isPedigreeUrl(preInfo?.frame||'')) { await navLog(p.Kit,{ step:'auto-all-skip-non-pedigree', frame:preInfo?.frame||'' }); await chrome.tabs.remove(tab.id); continue; }
      const rowsJson=buildIntermediaryRows(preInfo);
      const built=buildFamiliesFromRowsV9(rowsJson);
      const gedcom=await buildGedcom(built.people,{ kit:p.Kit, rootName: p?.Name||'', atdnaTotal: p?.AtdnaTotal||'' }, built.families);
      await saveCapture(p.Kit,{ rowsJson, gedcom, count: built.people.length, families: built.families.length, capturedAt:new Date().toISOString(), sourceUrl: preInfo?.frame||p.treeUrl }, built.logs);
      completed++;
      await chrome.tabs.remove(tab.id);
      const statusByKit=(await getState()).statusByKit; statusByKit[p.Kit]='yellow'; await saveStatusMap(statusByKit);
      renderList((await getState()).session.profiles, statusByKit);
    } catch(e){ console.error('Auto all failed for', p.Kit, e); await navLog(p.Kit,{ step:'auto-all-error', error:String(e) }); }
    }
    alert(`Auto captured ${completed}/${profiles.length}`);
  };

  // Bundle all captured GEDCOMs into a zip and download
  document.getElementById('downloadZipAll').onclick = async () => {
    const store=await chrome.storage.local.get(['gmCapturedByKit','gmGedmatchSession','gmSegmentsData']);
    const captured=store.gmCapturedByKit||{}; const entries=Object.entries(captured).filter(([,v])=>v?.gedcom);
    if(!entries.length){ alert('No GEDCOMs captured yet.'); return; }
    const enc=new TextEncoder();
    const files = entries.map(([kit,v])=>({name:`gedmatch-capture-${kit}.ged`, data:enc.encode(v.gedcom)}));

    // Optionally include floating individuals GEDCOM
    const includeFloating=document.getElementById('includeFloatingIndis')?.checked;
    if(includeFloating){
      // Use full autosomal CSV records we persisted during Parse CSV
      const s=await getState();
      const allRecords=s.allRecords||[];
      // Build set of kits that already have a captured GEDCOM to avoid duplication
      const kitsWithTree=new Set(Object.keys(captured));
      // Filter floating: present in one-to-many, but no captured GEDCOM
      const floating=allRecords.filter(r=>r?.Kit && !kitsWithTree.has(r.Kit));

      // Apply thresholds
      const minAtdna=parseFloat(document.getElementById('minAtdna')?.value||'0')||0;
      const minLargest=parseFloat(document.getElementById('minLargest')?.value||'0')||0;
      const pass=floating.filter(r=>{
        const a=parseFloat(String(r.AtdnaTotal).replace(/[^0-9.]/g,''))||0;
        const l=parseFloat(String(r.LargestCm).replace(/[^0-9.]/g,''))||0;
        return a>=minAtdna && l>=minLargest;
      });

      // Build a minimal GEDCOM with individuals only, include _OM_ATDNA like root handling
      const lines=[]; lines.push('0 HEAD','1 GEDC','2 VERS 5.5.1','1 CHAR UTF-8','1 SOUR GEDMATCH-IMPORTER');
      lines.push('0 @SUB1@ SUBM','1 NAME GEDmatch Importer User');
      const idFor=(i)=>`@I${i+1}@`;
      // Precompute segment index and email map once for floating individuals
      let floatSegIndex=null; try{ const storeSeg=await chrome.storage.local.get(['gmSegmentsData']); floatSegIndex=buildSegmentsIndex(storeSeg.gmSegmentsData?.segments||[]); } catch(_e){}
      let emailByKit=new Map(); try{ const all=(await chrome.storage.local.get(['gmAllCsvRecords'])).gmAllCsvRecords||[]; for(const r of all){ if(r?.Kit && r?.Email) emailByKit.set(r.Kit, r.Email); } } catch(_e){}
      pass.forEach((r,i)=>{
        const name=(r.Name||'Unknown'); const sex=r.Sex||'U';
        lines.push(`0 ${idFor(i)} INDI`);
        lines.push(`1 NAME ${name}`);
        lines.push(`1 SEX ${sex}`);
        const at=String(r.AtdnaTotal||'').trim(); if(at) lines.push(`1 _OM_ATDNA ${at}`);
        if(r.GedLink) { const cl=classifyGedLink(r.GedLink); if(cl.url) lines.push(`1 _OM_SOURCE_URL ${cl.url}`); }
        if(r.Kit){ lines.push('1 _OM_DNA_SOURCE'); lines.push(`2 _OM_KIT_ID ${r.Kit}`); lines.push('2 _OM_KIT_SITE GEDMATCH'); const em=emailByKit.get(r.Kit); if(em) lines.push(`2 _OM_SUBMITTER_EMAIL ${em}`); }
        // Segment data for floating individuals
        if(r.Kit && floatSegIndex && floatSegIndex.has(r.Kit)){
          lines.push(...emitSegmentLinesForKit(r.Kit, floatSegIndex.get(r.Kit)));
        }
      });
      lines.push('0 TRLR');
      files.push({ name:'gedmatch-floating-individuals.ged', data: enc.encode(lines.join('\n')) });
    }
    function dosDateTime(dt){ const d=dt||new Date(); const time=(d.getHours()<<11)|(d.getMinutes()<<5)|((d.getSeconds()/2)|0); const date=((d.getFullYear()-1980)<<9)|((d.getMonth()+1)<<5)|d.getDate(); return {time,date}; }
    const parts=[]; const centrals=[]; let offset=0; for(const f of files){ const {time,date}=dosDateTime(new Date()); const nameBytes=enc.encode(f.name);
      const lh=new Uint8Array(30+nameBytes.length); const dv=new DataView(lh.buffer);
      dv.setUint32(0,0x04034b50,true); dv.setUint16(4,20,true); dv.setUint16(6,0,true); dv.setUint16(8,0,true); dv.setUint16(10,time,true); dv.setUint16(12,date,true); dv.setUint32(14,0,true); dv.setUint32(18,f.data.length,true); dv.setUint32(22,f.data.length,true); dv.setUint16(26,nameBytes.length,true); dv.setUint16(28,0,true); lh.set(nameBytes,30);
      parts.push(lh, f.data);
      const ch=new Uint8Array(46+nameBytes.length); const dv2=new DataView(ch.buffer);
      dv2.setUint32(0,0x02014b50,true); dv2.setUint16(4,20,true); dv2.setUint16(6,20,true); dv2.setUint16(8,0,true); dv2.setUint16(10,0,true); dv2.setUint16(12,time,true); dv2.setUint16(14,date,true); dv2.setUint32(16,0,true); dv2.setUint32(20,f.data.length,true); dv2.setUint32(24,f.data.length,true); dv2.setUint16(28,nameBytes.length,true); dv2.setUint16(30,0,true); dv2.setUint16(32,0,true); dv2.setUint16(34,0,true); dv2.setUint16(36,0,true); dv2.setUint32(38,0,true); dv2.setUint32(42,offset,true); ch.set(nameBytes,46);
      centrals.push(ch); offset += lh.length + f.data.length; }
    const centralSize=centrals.reduce((a,b)=>a+b.length,0); const eocd=new Uint8Array(22); const dv3=new DataView(eocd.buffer);
    dv3.setUint32(0,0x06054b50,true); dv3.setUint16(4,0,true); dv3.setUint16(6,0,true); dv3.setUint16(8,files.length,true); dv3.setUint16(10,files.length,true); dv3.setUint32(12,centralSize,true); dv3.setUint32(16,offset,true); dv3.setUint16(20,0,true);
    const blob=new Blob([...parts, ...centrals, eocd], { type:'application/zip' });
    const url=URL.createObjectURL(blob); const filename=`gedmatch-captures-${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.zip`;
    await chrome.downloads.download({ url, filename, saveAs:true }); setTimeout(()=>URL.revokeObjectURL(url), 10000);
  };

  document.getElementById('btnDownloadGedcom').onclick = async () => { const st=await getState(); const kit=st.focusedKit; if(!kit){ alert('No focused individual.'); return;} const cap=st.capturedByKit[kit]; if(!cap?.gedcom){ alert('No captured GEDCOM for this kit yet. Click Capture Tree first.'); return;} const blob=new Blob([cap.gedcom], { type:'text/plain' }); const url=URL.createObjectURL(blob); const filename=`gedmatch-capture-${kit}.ged`; await chrome.downloads.download({ url, filename, saveAs: true }); setTimeout(()=>URL.revokeObjectURL(url), 10000); };
  document.getElementById('btnDownloadRowsJson').onclick = async () => { const st=await getState(); const kit=st.focusedKit; if(!kit){ alert('No focused individual.'); return;} const store=await chrome.storage.local.get(['gmCapturedByKit']); const cap=store.gmCapturedByKit?.[kit]; if(!cap?.rowsJson){ alert('No captured Rows JSON yet. Click Capture Tree first.'); return;} const blob=new Blob([JSON.stringify(cap.rowsJson, null, 2)], { type:'application/json' }); const url=URL.createObjectURL(blob); const filename=`gedmatch-rows-${kit}.json`; await chrome.downloads.download({ url, filename, saveAs:true }); setTimeout(()=>URL.revokeObjectURL(url), 10000); };

  document.getElementById('btnViewLog').onclick = async () => { const st=await getState(); const kit=st.focusedKit; if(!kit){ alert('No focused individual.'); return;} const logs=(await getState()).logsByKit?.[kit]; if(!logs || !logs.length){ alert('No logs captured yet. Click Capture Tree to generate logs.'); return;} const blob=new Blob([JSON.stringify(logs, null, 2)], { type:'application/json' }); const url=URL.createObjectURL(blob); const filename=`gedmatch-capture-log-${kit}.json`; await chrome.downloads.download({ url, filename, saveAs: true }); setTimeout(()=>URL.revokeObjectURL(url), 10000); };

  async function navLog(kit, entry){ try{ const store=await chrome.storage.local.get(['gmLogsByKit']); const logs=store.gmLogsByKit||{}; if(!logs[kit]) logs[kit]=[]; logs[kit].push({ t:new Date().toISOString(), source:'nav', ...entry }); await chrome.storage.local.set({ gmLogsByKit: logs }); }catch(e){ /* ignore */ } }

  function waitForTabComplete(tabId, timeoutMs=15000){ return new Promise(resolve=>{ let done=false; const timer=setTimeout(()=>{ if(done) return; done=true; chrome.tabs.onUpdated.removeListener(listener); resolve(false); }, timeoutMs); const listener=(id, info)=>{ if(id===tabId && info.status==='complete'){ if(done) return; done=true; clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); resolve(true); } }; chrome.tabs.onUpdated.addListener(listener); }); }

  // Listen for tree-detected messages to update UI immediately
  chrome.runtime.onMessage.addListener(async (msg) => {
    if(msg && msg.type==='gm-trees-detected'){ const st=await getState(); const s=st.session; const kit=msg.kit || st.focusedKit; if(!kit) return; const idx=s.profiles.findIndex(p=>p.Kit===kit); if(idx>=0){ s.profiles[idx].__trees=msg.trees||[]; await saveSession(s); setCurrentBox(s.profiles[idx], (await getState()).statusByKit[kit]||'red'); } }
  });

  // Live preview for floating individuals count
  async function updateFloatingPreview(){
    const el=document.getElementById('floatingPreview'); if(!el) return;
    const include=document.getElementById('includeFloatingIndis')?.checked;
    if(!include){ el.textContent=''; return; }
    const st=await getState();
    const captured=st.capturedByKit||{}; const kitsWithTree=new Set(Object.keys(captured));
    const allRecords=st.allRecords||[];
    const floating=allRecords.filter(r=>r?.Kit && !kitsWithTree.has(r.Kit));
    const minAtdna=parseFloat(document.getElementById('minAtdna')?.value||'0')||0;
    const minLargest=parseFloat(document.getElementById('minLargest')?.value||'0')||0;
    let count=0; for(const r of floating){
      const a=parseFloat(String(r.AtdnaTotal).replace(/[^0-9.]/g,''))||0;
      const l=parseFloat(String(r.LargestCm).replace(/[^0-9.]/g,''))||0;
      if(a>=minAtdna && l>=minLargest) count++;
    }
    el.textContent=`Floating preview: ${count}`;
  }
  document.getElementById('includeFloatingIndis')?.addEventListener('change', updateFloatingPreview);
  document.getElementById('minAtdna')?.addEventListener('input', updateFloatingPreview);
  document.getElementById('minLargest')?.addEventListener('input', updateFloatingPreview);
  // Initialize preview once at load
  updateFloatingPreview();

  document.getElementById('openNext').onclick = async () => { const st=await getState(); const s=st.session; if(!s.profiles?.length) return; const i=Math.max(0, Math.min(s.queueIndex||0, s.profiles.length-1)); const p=s.profiles[i]; s.queueIndex=i+1; await saveSession(s); setCurrentBox(p, (await getState()).statusByKit[p.Kit]||'red'); if(p?.treeUrl) { const tab=await chrome.tabs.create({ url:p.treeUrl, active:true }); await navLog(p.Kit,{ step:'opened-kit-url', url:p.treeUrl }); const loaded=await waitForTabComplete(tab.id); await navLog(p.Kit,{ step:'kit-page-complete', loaded }); const res=await autoNavigateToPedigree(tab.id); await navLog(p.Kit,{ step:'auto-navigate', mode:res?.mode||null, trees:(res?.trees||[]).length, nextUrl: res?.nextUrl||null }); if(res?.nextUrl){ try{ await chrome.runtime.sendMessage({ type:'gm-nav-to-url', tabId:tab.id, url:res.nextUrl }); await navLog(p.Kit,{ step:'background-nav', url:res.nextUrl }); }catch(e){ await navLog(p.Kit,{ step:'background-nav-error', error:String(e) }); } } if(res?.trees?.length){ const s2=(await getState()).session; const idx=s2.profiles.findIndex(x=>x.Kit===p.Kit); if(idx>=0){ s2.profiles[idx].__trees=res.trees; await saveSession(s2); setCurrentBox(s2.profiles[idx], (await getState()).statusByKit[p.Kit]||'red'); } } } };
  
  // Auto-navigate helper: when a 'find-gedcoms-by-kit' table is present, pick first tree and open pedigree; otherwise, on individual page, open Pedigree
  async function autoNavigateToPedigree(tabId){
    if(!tabId) return null;
    const [{ result } = {}] = await chrome.scripting.executeScript({ target:{tabId, allFrames:false}, func:()=>{
      try{
        const origin = location.origin;
        const data={ mode:'', trees:[], nextUrl:null };
        const table=document.querySelector('#gedcoms-table');
        if(table){
          const links=Array.from(table.querySelectorAll('tbody a[href*="/tools/gedcom/individual"]'));
          data.mode='list';
          data.trees=links.map(a=>{ const u=new URL(a.getAttribute('href'), origin); const id_family=u.searchParams.get('id_family'); const id_ged=u.searchParams.get('id_ged'); const pedigreeUrl=`${origin}/tools/gedcom/pedigree-chart?id_family=${encodeURIComponent(id_family)}&id_ged=${encodeURIComponent(id_ged)}`; return { individualUrl: u.toString(), pedigreeUrl, email:(a.textContent||'').trim() }; });
          if(data.trees[0]){ data.nextUrl=data.trees[0].pedigreeUrl; }
          return data;
        }
        // Individual page
        const url=new URL(location.href);
        if(url.pathname.includes('/tools/gedcom/individual')){
          const id_family=url.searchParams.get('id_family'); const id_ged=url.searchParams.get('id_ged');
          if(id_family&&id_ged){ const ped=`${origin}/tools/gedcom/pedigree-chart?id_family=${encodeURIComponent(id_family)}&id_ged=${encodeURIComponent(id_ged)}`; return { mode:'individual', trees:[{ individualUrl:url.toString(), pedigreeUrl: ped }], nextUrl: ped }; }
        }
        if(location.pathname.includes('/tools/gedcom/pedigree-chart')) return { mode:'already-pedigree', trees:[], nextUrl:null };
        return { mode:'no-op', trees:[], nextUrl:null };
      }catch(e){ return { mode:'error', error:e.message, trees:[], nextUrl:null }; }
    }});
    return result||null;
  }

  document.getElementById('exportJson').onclick = async () => { const s=(await getState()).session; const blob=new Blob([JSON.stringify(s.bundle||{}, null, 2)], { type:'application/json' }); const url=URL.createObjectURL(blob); const filename=`gedmatch-import-${new Date().toISOString().replace(/[:.]/g,'-')}.json`; await chrome.downloads.download({ url, filename, saveAs:true }); setTimeout(()=>URL.revokeObjectURL(url), 10000); };

  const st = await getState(); if (st.session.profiles?.length) { renderList(st.session.profiles, st.statusByKit); updateStats(st.session.profiles, st.pendingMeta?.name ? `Last: ${st.pendingMeta.name}` : undefined); if (st.focusedKit) { const p = st.session.profiles.find(x => x.Kit === st.focusedKit); if (p) setCurrentBox(p, st.statusByKit[p.Kit] || 'red'); } } else if (st.pendingMeta?.name) { updateStats([], `Pending: ${st.pendingMeta.name}`); } else { updateStats([]); }

  // Parse ASCII from textarea using V6
  document.getElementById('btnParseAscii').onclick = async () => {
    const txt=(document.getElementById('asciiText').value||'').trim();
    if(!txt){ alert('Paste the ASCII pedigree into the textbox first.'); return; }
    try {
      const pre={ ok:true, html: txt.replace(/\n/g,'<br>'), text: txt, anchors: [] };
      const { people, families, logs }=parseIndividualsFromPreV7(pre);
      const gedcom=await buildGedcom(people, null, families);
      const blob=new Blob([gedcom], { type:'text/plain' });
      const url=URL.createObjectURL(blob);
      await chrome.downloads.download({ url, filename:'gedmatch-ascii-parsed.ged', saveAs:true });
      setTimeout(()=>URL.revokeObjectURL(url), 10000);
      console.log('V6 ASCII parse:', { people:people.length, families:families.length, logs });
      alert(`Parsed ASCII: ${people.length} people, ${families.length} families`);
    } catch(e){ console.error('Parse ASCII failed', e); alert('Parse ASCII failed: '+(e?.message||e)); }
  };
})();
