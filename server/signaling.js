// Servidor de sinalização: presença dos agentes, pedidos de acesso com código de confirmação,
// sessões e repasse de mensagens WebRTC (a mídia vai direto P2P ou via TURN, cifrada DTLS-SRTP).
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { db, audit, tempPassword, verifyPassword, sha256, getSetting } = require('./db');
const { userFromRequest, inCompany } = require('./auth');
const { PLANS } = require('./plans');

const agents = new Map();   // deviceId -> { ws, password, device, unattendedReady, sysinfo }
const techs = new Map();    // userId -> Set<ws>
const pending = new Map();  // reqId -> { ... }
const live = new Map();     // sessionId -> { agentWs, techWs, deviceId, user, perms, ticketId, recording }
const failures = new Map(); // `${ip}|${deviceId}` -> { count, until }

const REQUEST_TIMEOUT = 30_000;
const MAX_FAILS = 5;
const LOCK_MS = 24 * 60 * 60 * 1000;
const ALL_PERMS = ['ver', 'controlar', 'arquivos', 'clipboard', 'gravar', 'reiniciar'];

const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const ipOf = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const confirmCode = () => `${crypto.randomInt(10, 100)} · ${crypto.randomInt(10, 100)}`;

function loadDevice(id) {
  return db.prepare(`SELECT d.*, c.name company_name, c.verified company_verified, c.code company_code
    FROM devices d LEFT JOIN companies c ON c.id=d.company_id WHERE d.id=?`).get(id);
}
function companyName(id) { const c = id && db.prepare('SELECT name FROM companies WHERE id=?').get(id); return c ? c.name : null; }

function rotatePassword(deviceId) {
  const a = agents.get(deviceId);
  if (!a) return;
  a.password = tempPassword();
  send(a.ws, { type: 'password', password: a.password });
}

function activeSessionCount() { return live.size; }
function planLimit() { return (PLANS[getSetting('plan', 'equipe')] || PLANS.equipe).sessions; }

// ---------- API usada pelas rotas HTTP ----------
function status(deviceId) {
  if ([...live.values()].some((s) => s.deviceId === deviceId)) return 'em_sessao';
  return agents.has(deviceId) ? 'online' : 'offline';
}
function presence(userId) {
  if ([...live.values()].some((s) => s.user.id === userId)) return 'em_sessao';
  return techs.has(userId) ? 'livre' : 'ausente';
}
function stats() { return { activeSessions: live.size, limit: planLimit(), agentsOnline: agents.size }; }
function liveSessions() { return [...live.entries()].map(([id, s]) => ({ id, deviceId: s.deviceId, techId: s.user.id })); }

// ---------- conexão ----------
function attach(server) {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 * 1024 });

  wss.on('connection', (ws, req) => {
    ws.ip = ipOf(req);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    const user = userFromRequest(req);
    if (user) {
      ws.user = user;
      if (!techs.has(user.id)) techs.set(user.id, new Set());
      techs.get(user.id).add(ws);
    }
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      try { handle(ws, m); } catch (err) { console.error('ws', err); send(ws, { type: 'error', message: 'Erro interno.' }); }
    });
    ws.on('close', () => cleanup(ws));
  });

  setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false; ws.ping();
    }
    for (const [id, a] of agents) db.prepare('UPDATE devices SET last_seen=? WHERE id=?').run(Date.now(), id);
  }, 20_000).unref();
}

function handle(ws, m) {
  switch (m.type) {
    // ===== agente (computador que recebe acesso) =====
    case 'hello': {
      const d = loadDevice(String(m.deviceId || ''));
      if (!d || !m.agentKey || sha256(String(m.agentKey)) !== d.agent_key_hash) {
        return send(ws, { type: 'error', code: 'unknown_device', message: 'Dispositivo não reconhecido. Reinstale o agente.' });
      }
      const prev = agents.get(d.id);
      if (prev && prev.ws !== ws) { send(prev.ws, { type: 'error', code: 'replaced', message: 'Este ID foi aberto em outra janela.' }); prev.ws.close(); }
      ws.deviceId = d.id;
      agents.set(d.id, { ws, password: tempPassword(), device: d, unattendedReady: false, sysinfo: m.sysinfo || null });
      db.prepare('UPDATE devices SET last_seen=?, os=COALESCE(?,os) WHERE id=?').run(Date.now(), m.sysinfo?.os || null, d.id);
      const a = agents.get(d.id);
      notifyQueueIfTicket(d);
      return send(ws, {
        type: 'welcome', deviceId: d.id, password: a.password, name: d.name, accessMode: d.access_mode,
        company: d.company_id ? { name: d.company_name, verified: !!d.company_verified } : null, quick: !!d.quick,
      });
    }
    case 'rotate': if (ws.deviceId) rotatePassword(ws.deviceId); return;
    case 'agent-state': {
      const a = ws.deviceId && agents.get(ws.deviceId);
      if (a) { a.unattendedReady = !!m.unattendedReady; if (m.sysinfo) a.sysinfo = m.sysinfo; }
      return;
    }
    case 'ticket': {
      const a = ws.deviceId && agents.get(ws.deviceId);
      if (!a) return;
      const open = db.prepare("SELECT id FROM tickets WHERE device_id=? AND status IN ('aberto','em_atendimento')").get(a.device.id);
      if (open) return send(ws, { type: 'ticket-ok', id: open.id, already: true });
      const r = db.prepare('INSERT INTO tickets(company_id,device_id,origin,reason,requester,created_at) VALUES(?,?,?,?,?,?)')
        .run(a.device.company_id, a.device.id, a.device.quick ? 'quicksupport' : 'botao', String(m.reason || 'Pedido de suporte').slice(0, 300),
          String(m.requester || a.device.name).slice(0, 80), Date.now());
      audit({ companyId: a.device.company_id, deviceId: a.device.id, actor: a.device.name, event: 'chamado_aberto', details: { motivo: m.reason }, ip: ws.ip });
      broadcastTechs(a.device.company_id, { type: 'queue-changed' });
      return send(ws, { type: 'ticket-ok', id: Number(r.lastInsertRowid) });
    }
    case 'accept': case 'refuse': {
      const p = pending.get(m.reqId);
      if (!p || p.deviceId !== ws.deviceId) return;
      if (m.type === 'refuse') {
        finishPending(m.reqId);
        audit({ companyId: p.device.company_id, userId: p.user.id, actor: p.user.name, deviceId: p.deviceId, event: 'acesso_recusado', ip: ws.ip });
        return send(p.techWs, { type: 'refused', message: 'O usuário recusou o pedido de acesso.' });
      }
      const granted = (Array.isArray(m.perms) ? m.perms : []).filter((x) => p.perms.includes(x));
      if (!granted.includes('ver')) granted.unshift('ver');
      return startSession(m.reqId, granted, false);
    }

    // ===== técnico (console) =====
    case 'connect': return requestAccess(ws, m);
    case 'cancel': {
      const p = pending.get(m.reqId);
      if (p && p.techWs === ws) { finishPending(m.reqId); send(agents.get(p.deviceId)?.ws, { type: 'cancel', reqId: m.reqId }); }
      return;
    }

    // ===== ambos =====
    case 'signal': {
      const s = live.get(m.sid);
      if (!s) return;
      const target = ws === s.agentWs ? s.techWs : ws === s.techWs ? s.agentWs : null;
      return send(target, { type: 'signal', sid: m.sid, data: m.data });
    }
    case 'session-event': {
      const s = live.get(m.sid);
      if (!s || (ws !== s.agentWs && ws !== s.techWs)) return;
      const allowed = ['arquivo_enviado', 'arquivo_recebido', 'clipboard_enviado', 'qualidade_alterada', 'monitor_trocado', 'rota'];
      if (!allowed.includes(m.event)) return;
      if (m.event === 'rota') { db.prepare('UPDATE sessions SET route=? WHERE id=?').run(String(m.details?.route || ''), m.sid); return; }
      if (m.event.startsWith('arquivo')) db.prepare('UPDATE sessions SET files=files+1 WHERE id=?').run(m.sid);
      audit({ companyId: s.device.company_id, userId: s.user.id, actor: ws === s.techWs ? s.user.name : s.device.name,
        deviceId: s.deviceId, sessionId: m.sid, event: m.event, details: m.details, ip: ws.ip });
      return;
    }
    case 'recording': {
      const s = live.get(m.sid);
      if (!s || ws !== s.techWs) return;
      if (m.on && !s.perms.includes('gravar')) return send(ws, { type: 'error', message: 'O usuário não liberou a gravação da sessão.' });
      s.recording = !!m.on;
      send(s.agentWs, { type: 'recording', sid: m.sid, on: s.recording });
      if (m.on) audit({ companyId: s.device.company_id, userId: s.user.id, actor: s.user.name, deviceId: s.deviceId, sessionId: m.sid, event: 'gravacao_iniciada', ip: ws.ip });
      return;
    }
    case 'end': return endSession(m.sid, ws === live.get(m.sid)?.agentWs ? 'usuario' : 'tecnico', ws);
  }
}

function requestAccess(ws, m) {
  const user = ws.user;
  if (!user) return send(ws, { type: 'error', message: 'Faça login no console para conectar.' });
  if (user.role === 'funcionario') return send(ws, { type: 'error', message: 'O perfil Funcionário não acessa outras máquinas.' });
  const deviceId = String(m.deviceId || '').replace(/\D/g, '');
  const a = agents.get(deviceId);
  const d = a ? a.device : loadDevice(deviceId);
  if (!d) return send(ws, { type: 'error', message: 'ID não encontrado.' });
  if (!a) return send(ws, { type: 'error', message: `${d.name} está offline agora.` });
  if ([...live.values()].some((s) => s.deviceId === deviceId)) return send(ws, { type: 'error', message: 'Este computador já está em uma sessão.' });
  if (activeSessionCount() >= planLimit()) return send(ws, { type: 'error', message: `Limite do plano atingido: ${planLimit()} sessões simultâneas.` });

  const key = `${ws.ip}|${deviceId}`;
  const f = failures.get(key);
  if (f && f.until > Date.now()) return send(ws, { type: 'error', message: 'Muitas tentativas erradas. Acesso a este ID bloqueado por 24 h.' });

  const inScope = inCompany(user, d.company_id);
  // Fora da própria empresa só entra com a senha (temporária ou fixa do não assistido).
  if (!inScope) {
    const pw = String(m.password || '').trim();
    const ok = pw && (pw === a.password || (d.unattended_pass && verifyPassword(pw, d.unattended_pass)));
    if (!ok) {
      const cur = f && !f.until ? f : { count: 0, until: 0 }; // bloqueio vencido recomeça a contagem
      cur.count += 1;
      if (cur.count >= MAX_FAILS) {
        cur.until = Date.now() + LOCK_MS;
        audit({ companyId: d.company_id, userId: user.id, actor: user.name, deviceId, event: 'bloqueio_forca_bruta', details: { tentativas: cur.count }, ip: ws.ip });
      } else {
        audit({ companyId: d.company_id, userId: user.id, actor: user.name, deviceId, event: 'senha_incorreta', details: { tentativa: cur.count }, ip: ws.ip });
      }
      failures.set(key, cur);
      return send(ws, { type: 'error', message: pw ? `Senha incorreta (${cur.count} de ${MAX_FAILS}).` : 'Digite a senha mostrada no computador do cliente.' });
    }
  }
  failures.delete(key);

  const wanted = (Array.isArray(m.perms) && m.perms.length ? m.perms : ALL_PERMS).filter((x) => ALL_PERMS.includes(x));
  const perms = m.mode === 'visualizar' ? ['ver'] : m.mode === 'arquivos' ? ['ver', 'arquivos'] : wanted;
  if (!perms.includes('ver')) perms.unshift('ver');

  const reqId = crypto.randomUUID();
  const code = confirmCode();
  const p = { reqId, deviceId, device: d, user, techWs: ws, perms, code, ticketId: m.ticketId || null, timer: null };
  pending.set(reqId, p);

  const unattended = inScope && d.access_mode === 'nao_assistido' && a.unattendedReady;
  audit({ companyId: d.company_id, userId: user.id, actor: user.name, deviceId, event: 'pedido_acesso',
    details: { permissoes: perms, nao_assistido: unattended }, ip: ws.ip });

  if (unattended) {
    send(ws, { type: 'pending', reqId, code, device: { id: d.id, name: d.name }, unattended: true });
    return startSession(reqId, perms.filter((x) => x !== 'reiniciar'), true);
  }
  p.timer = setTimeout(() => {
    if (!pending.has(reqId)) return;
    finishPending(reqId);
    audit({ companyId: d.company_id, userId: user.id, actor: user.name, deviceId, event: 'pedido_expirado' });
    send(ws, { type: 'refused', message: 'O usuário não respondeu em 30 segundos.' });
    send(a.ws, { type: 'cancel', reqId });
  }, REQUEST_TIMEOUT);

  send(ws, { type: 'pending', reqId, code, device: { id: d.id, name: d.name }, timeout: REQUEST_TIMEOUT });
  send(a.ws, {
    type: 'request', reqId, code, perms, timeout: REQUEST_TIMEOUT,
    tech: {
      name: user.name, initials: user.name.split(/\s+/).map((x) => x[0]).slice(0, 2).join('').toUpperCase(),
      company: user.company_name || companyName(d.company_id) || 'Domma View',
      verified: !!db.prepare('SELECT verified FROM companies WHERE id=?').get(user.company_id ?? -1)?.verified,
      fromId: m.fromId || null,
    },
  });
}

function finishPending(reqId) {
  const p = pending.get(reqId);
  if (p) { clearTimeout(p.timer); pending.delete(reqId); }
  return p;
}

function startSession(reqId, perms, unattended) {
  const p = finishPending(reqId);
  if (!p) return;
  const a = agents.get(p.deviceId);
  if (!a) return send(p.techWs, { type: 'error', message: 'O computador ficou offline.' });
  const sid = crypto.randomUUID();
  const s = { agentWs: a.ws, techWs: p.techWs, deviceId: p.deviceId, device: p.device, user: p.user, perms, ticketId: p.ticketId, recording: false, started: Date.now() };
  live.set(sid, s);
  db.prepare('INSERT INTO sessions(id,device_id,tech_id,company_id,ticket_id,started_at,permissions,unattended) VALUES(?,?,?,?,?,?,?,?)')
    .run(sid, p.deviceId, p.user.id, p.device.company_id, p.ticketId, s.started, JSON.stringify(perms), unattended ? 1 : 0);
  if (p.ticketId) {
    db.prepare("UPDATE tickets SET status='em_atendimento', taken_by=?, taken_at=COALESCE(taken_at,?) WHERE id=?").run(p.user.id, Date.now(), p.ticketId);
    broadcastTechs(p.device.company_id, { type: 'queue-changed' });
  }
  audit({ companyId: p.device.company_id, userId: p.user.id, actor: unattended ? p.user.name : p.device.name, deviceId: p.deviceId, sessionId: sid,
    event: unattended ? 'acesso_nao_assistido' : 'acesso_permitido', details: { codigo: p.code, permissoes: perms } });
  const info = { sid, perms, unattended, device: { id: p.device.id, name: p.device.name, company: p.device.company_name, os: p.device.os } };
  send(a.ws, { type: 'session', ...info, tech: { name: p.user.name, company: p.user.company_name } });
  send(p.techWs, { type: 'session', ...info, sysinfo: a.sysinfo });
}

function endSession(sid, by, fromWs) {
  const s = live.get(sid);
  if (!s) return;
  if (fromWs && fromWs !== s.agentWs && fromWs !== s.techWs) return;
  live.delete(sid);
  const now = Date.now();
  db.prepare('UPDATE sessions SET ended_at=?, ended_by=? WHERE id=?').run(now, by, sid);
  if (s.ticketId) {
    db.prepare("UPDATE tickets SET status='resolvido', closed_at=? WHERE id=? AND status='em_atendimento'").run(now, s.ticketId);
    broadcastTechs(s.device.company_id, { type: 'queue-changed' });
  }
  audit({ companyId: s.device.company_id, userId: s.user.id, actor: by === 'usuario' ? s.device.name : s.user.name, deviceId: s.deviceId, sessionId: sid,
    event: 'sessao_encerrada', details: { por: by, duracao_s: Math.round((now - s.started) / 1000) } });
  send(s.agentWs, { type: 'end', sid, by });
  send(s.techWs, { type: 'end', sid, by });
  rotatePassword(s.deviceId); // senha temporária muda a cada sessão
}

function cleanup(ws) {
  if (ws.user) {
    const set = techs.get(ws.user.id);
    if (set) { set.delete(ws); if (!set.size) techs.delete(ws.user.id); }
  }
  if (ws.deviceId && agents.get(ws.deviceId)?.ws === ws) {
    const gone = agents.get(ws.deviceId).device;
    agents.delete(ws.deviceId);
    db.prepare('UPDATE devices SET last_seen=? WHERE id=?').run(Date.now(), ws.deviceId);
    notifyQueueIfTicket(gone);
  }
  for (const [reqId, p] of pending) {
    if (p.techWs === ws || p.deviceId === ws.deviceId) {
      finishPending(reqId);
      send(p.techWs === ws ? agents.get(p.deviceId)?.ws : p.techWs, p.techWs === ws ? { type: 'cancel', reqId } : { type: 'refused', message: 'O computador desconectou.' });
    }
  }
  for (const [sid, s] of live) if (s.agentWs === ws || s.techWs === ws) endSession(sid, s.agentWs === ws ? 'usuario_desconectou' : 'tecnico_desconectou');
}

function notifyQueueIfTicket(d) {
  if (db.prepare("SELECT 1 FROM tickets WHERE device_id=? AND status IN ('aberto','em_atendimento')").get(d.id)) broadcastTechs(d.company_id, { type: 'queue-changed' });
}

function broadcastTechs(companyId, msg) {
  for (const set of techs.values()) for (const ws of set) if (ws.user && (ws.user.role === 'admin' || ws.user.company_id === companyId)) send(ws, msg);
}

function kickDevice(deviceId) {
  const a = agents.get(deviceId);
  if (a) { send(a.ws, { type: 'error', code: 'unknown_device', message: 'Este computador foi removido da conta.' }); a.ws.close(); }
}

module.exports = { attach, status, presence, stats, liveSessions, broadcastTechs, kickDevice, live };
