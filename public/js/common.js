// Utilitários compartilhados entre console e agente.
const DV = (() => {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  async function api(path, opts = {}) {
    const init = { method: opts.method || (opts.body ? 'POST' : 'GET'), headers: {}, credentials: 'same-origin' };
    if (opts.body instanceof Blob) { init.body = opts.body; init.headers['Content-Type'] = opts.body.type || 'application/octet-stream'; }
    else if (opts.body) { init.body = JSON.stringify(opts.body); init.headers['Content-Type'] = 'application/json'; }
    const r = await fetch(path, init);
    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('json') ? await r.json() : await r.text();
    if (!r.ok) { const e = new Error((data && data.error) || `Erro ${r.status}`); e.status = r.status; throw e; }
    return data;
  }

  function toast(text, err = false) {
    let box = $('#toasts');
    if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
    const t = document.createElement('div');
    t.className = 'toast' + (err ? ' err' : '');
    t.textContent = text;
    box.appendChild(t);
    setTimeout(() => t.remove(), 4200);
  }

  function modal(html, { onMount, dismissable = true } = {}) {
    const o = document.createElement('div');
    o.className = 'overlay';
    o.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
    const close = () => o.remove();
    if (dismissable) o.addEventListener('mousedown', (e) => { if (e.target === o) close(); });
    o.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
    document.body.appendChild(o);
    onMount && onMount(o, close);
    return { el: o, close };
  }

  const logo = (size = 26) => `<svg width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true"><path d="M3 19c3 0 4-9 7-9s3 12 6 12 3-14 6-14 3 11 7 11" fill="none" stroke="#8b74ff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const fmtId = (id) => String(id || '').replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3');
  const fmtBytes = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
  const fmtDur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((x) => String(x).padStart(2, '0')).join(':'); };
  const fmtWhen = (ts) => {
    if (!ts) return '—';
    const d = new Date(ts), t = new Date();
    const hm = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === t.toDateString()) return `Hoje, ${hm}`;
    const y = new Date(t); y.setDate(t.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return `Ontem, ${hm}`;
    return `${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}, ${hm}`;
  };
  const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).map((x) => x[0]).slice(0, 2).join('').toUpperCase();

  // Cliente WebSocket com reconexão
  function socket(onMessage, onOpen) {
    let ws, closed = false, retry = 1000;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const out = {
      send(m) { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(m)); return true; } return false; },
      close() { closed = true; ws && ws.close(); },
      get open() { return ws && ws.readyState === 1; },
    };
    (function connect() {
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => { retry = 1000; onOpen && onOpen(out); };
      ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data), out); } catch (err) { console.error(err); } };
      ws.onclose = () => { if (!closed) { onMessage({ type: 'disconnected' }, out); setTimeout(connect, retry); retry = Math.min(retry * 2, 15000); } };
    })();
    return out;
  }

  // Informações do sistema que o navegador expõe (aba Sistema)
  async function sysinfo() {
    const ua = navigator.userAgent;
    const os = /Windows NT 10/.test(ua) ? 'Windows 10/11' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : 'Desconhecido';
    const browser = (ua.match(/(Edg|Chrome|Firefox|Safari)\/([\d.]+)/) || [])[0] || ua.slice(0, 40);
    let disk = null;
    try { const e = await navigator.storage.estimate(); disk = e.quota ? `${fmtBytes(e.quota)} disponíveis ao navegador` : null; } catch {}
    return {
      os, browser, cpu: navigator.hardwareConcurrency ? `${navigator.hardwareConcurrency} núcleos` : null,
      memory: navigator.deviceMemory ? `${navigator.deviceMemory} GB (aprox.)` : null,
      screen: `${screen.width}×${screen.height} @${window.devicePixelRatio || 1}x`, language: navigator.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, disk, online: navigator.onLine, agent: 'Agente web 1.0.0',
    };
  }

  return { esc, $, $$, api, toast, modal, logo, fmtId, fmtBytes, fmtDur, fmtWhen, initials, socket, sysinfo };
})();

// Protocolo de dados da sessão (canal WebRTC 'dv'): chat, arquivos, área de transferência, qualidade.
// Arquivos vão em pedaços de 16 KB pelo mesmo canal cifrado, com controle de buffer.
const DVChannel = (() => {
  const CHUNK = 16 * 1024;
  function wrap(dc, handlers) {
    dc.binaryType = 'arraybuffer';
    let incoming = null; // { id, name, size, parts, got }
    dc.onmessage = (e) => {
      if (typeof e.data !== 'string') {
        if (!incoming) return;
        incoming.parts.push(e.data); incoming.got += e.data.byteLength;
        handlers.onProgress && handlers.onProgress({ id: incoming.id, name: incoming.name, done: incoming.got, size: incoming.size, dir: 'in' });
        if (incoming.got >= incoming.size) {
          const blob = new Blob(incoming.parts);
          const f = incoming; incoming = null;
          handlers.onFile && handlers.onFile({ id: f.id, name: f.name, size: f.size, blob });
        }
        return;
      }
      const m = JSON.parse(e.data);
      if (m.t === 'file-start') {
        incoming = { id: m.id, name: m.name, size: m.size, parts: [], got: 0 };
        if (m.size === 0) { const f = incoming; incoming = null; handlers.onFile && handlers.onFile({ ...f, blob: new Blob([]) }); }
        return;
      }
      handlers.onMessage && handlers.onMessage(m);
    };
    const queue = [];
    let sending = false;
    async function pump() {
      if (sending) return; sending = true;
      while (queue.length) {
        const { file, id, resolve } = queue.shift();
        dc.send(JSON.stringify({ t: 'file-start', id, name: file.name, size: file.size }));
        let off = 0;
        while (off < file.size) {
          if (dc.readyState !== 'open') { sending = false; return; }
          if (dc.bufferedAmount > 4 * 1024 * 1024) { await new Promise((r) => setTimeout(r, 30)); continue; }
          const buf = await file.slice(off, off + CHUNK).arrayBuffer();
          dc.send(buf); off += buf.byteLength;
          handlers.onProgress && handlers.onProgress({ id, name: file.name, done: off, size: file.size, dir: 'out' });
        }
        resolve();
      }
      sending = false;
    }
    return {
      send: (m) => dc.readyState === 'open' && dc.send(JSON.stringify(m)),
      sendFile: (file, id = Math.random().toString(36).slice(2)) => new Promise((resolve) => { queue.push({ file, id, resolve }); pump(); }),
      get open() { return dc.readyState === 'open'; },
    };
  }
  return { wrap };
})();
