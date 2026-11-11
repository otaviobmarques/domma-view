// Teste do serviço do Windows num Windows de verdade (workflow agente-windows.yml).
// Instala o serviço apontando para o servidor local, confere registro, pipe de chaves,
// sessão pela "tela de login" (sem o app do usuário), quadros, mouse, bloqueio de teclado e Ctrl+Alt+Del.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const WebSocket = require('ws');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const EXE = path.resolve(process.env.SERVICE_EXE || path.join(__dirname, '..', 'agent-service', 'dist', 'DommaViewService.exe'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cookie = '';
async function api(p, opts = {}) {
  const r = await fetch(BASE + p, { method: opts.method || (opts.body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const t = await r.text(); try { return JSON.parse(t); } catch { return t; }
}
function cursor() {
  const out = execFileSync('powershell', ['-NoProfile', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.Cursor]::Position; $v=[System.Windows.Forms.SystemInformation]::VirtualScreen; "$($p.X),$($p.Y),$($v.X),$($v.Y),$($v.Width),$($v.Height)"']).toString().trim();
  const [x, y, vx, vy, vw, vh] = out.split(',').map(Number); return { x, y, vx, vy, vw, vh };
}

(async () => {
  console.log(execFileSync(EXE, ['install', '--server', BASE, '--empresa', 'DommaView-Setup_ML-4821-ECV.exe']).toString().trim());
  await api('/api/login', { body: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD } });
  let dev;
  for (let i = 0; i < 60 && !dev; i++) {
    const list = await api('/api/devices');
    dev = Array.isArray(list) && list.find((d) => d.status === 'online');
    if (!dev) await sleep(1000);
  }
  assert(dev, 'o serviço registrou o computador e ficou online');
  console.log('✓ serviço registrou e conectou:', dev.id, dev.name);

  const creds = JSON.parse(fs.readFileSync('\\\\.\\pipe\\DommaViewCreds', 'utf8'));
  assert.strictEqual(creds.deviceId, dev.id, 'pipe de chaves entrega o mesmo ID');
  assert(creds.agentKey && creds.agentKey.length > 20, 'pipe entrega a chave do agente');
  console.log('✓ pipe de chaves para o app do usuário');

  await api(`/api/devices/${dev.id}`, { method: 'PATCH', body: { access_mode: 'nao_assistido' } });
  const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws', { headers: { Cookie: cookie } });
  const inbox = [];
  ws.on('message', (raw) => inbox.push(JSON.parse(raw)));
  await new Promise((r) => ws.on('open', r));
  const waitFor = async (pred, ms = 20000) => { const t = Date.now(); for (;;) { const i = inbox.findIndex(pred); if (i >= 0) return inbox.splice(i, 1)[0]; if (Date.now() - t > ms) return null; await sleep(100); } };
  ws.send(JSON.stringify({ type: 'connect', deviceId: dev.id }));
  const sess = await waitFor((m) => m.type === 'session' || m.type === 'error');
  assert(sess && sess.type === 'session', `sessão aberta: ${JSON.stringify(sess)}`);
  assert(sess.relay && sess.service, 'sessão pelo serviço (sem app do usuário)');
  console.log('✓ sessão não assistida pelo serviço (modo tela de login)');

  const f1 = await waitFor((m) => m.type === 'svc-frame');
  assert(f1, 'chegaram quadros da tela');
  const jpg = Buffer.from(f1.data, 'base64');
  assert(jpg[0] === 0xff && jpg[1] === 0xd8 && jpg.length > 2000, 'quadro é um JPEG válido');
  console.log(`✓ quadro da tela: ${f1.w}×${f1.h}, ${Math.round(jpg.length / 1024)} KB`);
  fs.writeFileSync(path.join(process.env.RUNNER_TEMP || '.', 'quadro-servico.jpg'), jpg);

  ws.send(JSON.stringify({ type: 'priv', sid: sess.sid, op: 'input', m: { k: 'move', x: 0.3, y: 0.6 } }));
  await sleep(800);
  const c = cursor();
  const ex = c.vx + 0.3 * (c.vw - 1), ey = c.vy + 0.6 * (c.vh - 1);
  console.log(`  cursor ${c.x},${c.y} · esperado ≈ ${Math.round(ex)},${Math.round(ey)}`);
  assert(Math.abs(c.x - ex) <= 3 && Math.abs(c.y - ey) <= 3, 'serviço moveu o cursor real');
  console.log('✓ mouse pelo serviço (SYSTEM)');

  for (const on of [true, false]) {
    ws.send(JSON.stringify({ type: 'priv', sid: sess.sid, op: 'block', on }));
    const r = await waitFor((m) => m.type === 'priv-result' && m.op === 'block');
    assert(r && r.ok, `bloqueio de teclado ${on ? 'ligado' : 'desligado'}: ${JSON.stringify(r)}`);
  }
  console.log('✓ bloquear e liberar teclado/mouse do cliente');

  ws.send(JSON.stringify({ type: 'priv', sid: sess.sid, op: 'sas' }));
  const sas = await waitFor((m) => m.type === 'priv-result' && m.op === 'sas');
  assert(sas && sas.ok, `Ctrl+Alt+Del: ${JSON.stringify(sas)}`);
  console.log('✓ Ctrl+Alt+Del (SendSAS) executado pelo serviço');
  const d = await waitFor((m) => m.type === 'svc-desktop', 6000);
  console.log(d ? `✓ tela segura detectada: desktop ${d.name}` : '  (tela segura não apareceu; ambiente sem console interativo?)');

  ws.send(JSON.stringify({ type: 'end', sid: sess.sid }));
  await sleep(500); ws.close();
  console.log(execFileSync(EXE, ['uninstall']).toString().trim());
  console.log('\nSERVIÇO DO WINDOWS OK');
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
