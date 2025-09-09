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
