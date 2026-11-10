// Domma View — servidor HTTP (API + console web) e sinalização WebSocket.
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const {
  db, DATA_DIR, n, sha256, hashPassword, verifyPassword, newDeviceId, randomDigits, audit, verifyAudit,
  encryptToFile, decryptFile, getSetting, setSetting,
} = require('./db');
const { issueToken, setCookie, clearCookie, MATRIX, can, inCompany, companyScope, requireAuth, requirePerm } = require('./auth');
const signaling = require('./signaling');
const { PLANS } = require('./plans');
const { seed } = require('./seed');

seed();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '200kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

const ip = (req) => req.ip;
const bad = (res, status, error) => res.status(status).json({ error });
const now = () => Date.now();

// ---------------- config pública ----------------
app.get('/api/config', (req, res) => {
  const ice = [{ urls: (process.env.STUN_URLS || 'stun:stun.l.google.com:19302').split(',') }];
  if (process.env.TURN_URL) ice.push({ urls: process.env.TURN_URL.split(','), username: process.env.TURN_USER, credential: process.env.TURN_PASS });
  res.json({ iceServers: ice, version: '1.0.0' });
});

// ---------------- login (força bruta: 5 erros → 15 min) ----------------
const loginFails = new Map();
app.post('/api/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const key = `${ip(req)}|${email}`;
  const f = loginFails.get(key);
  if (f && f.until > now()) return bad(res, 429, 'Muitas tentativas. Tente de novo em 15 minutos.');
  const u = db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(email);
  if (!u || !verifyPassword(req.body.password || '', u.pass)) {
    const cur = f && !f.until ? f : { count: 0, until: 0 };
    cur.count++;
    if (cur.count >= 5) cur.until = now() + 15 * 60 * 1000;
    loginFails.set(key, cur);
    audit({ companyId: u?.company_id, userId: u?.id, actor: email, event: 'login_falhou', ip: ip(req) });
    return bad(res, 401, 'E-mail ou senha incorretos.');
  }
  loginFails.delete(key);
  audit({ companyId: u.company_id, userId: u.id, actor: u.name, event: 'login', ip: ip(req) });
  setCookie(res, issueToken(u.id));
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => { clearCookie(res); res.json({ ok: true }); });

// --------------- agente: lookup / registro (instalador) / QuickSupport ---------------
app.get('/api/companies/lookup', (req, res) => {
  const c = db.prepare('SELECT id,name,code,grp,verified FROM companies WHERE code=?').get(String(req.query.code || '').trim().toUpperCase());
  if (!c) return bad(res, 404, 'Código de empresa não encontrado.');
  res.json({ name: c.name, code: c.code, grp: c.grp, verified: !!c.verified });
});

const registerHits = new Map();
function throttle(req, res, max = 20) {
  const k = ip(req); const r = registerHits.get(k) || { c: 0, t: now() };
  if (now() - r.t > 60 * 60 * 1000) { r.c = 0; r.t = now(); }
  r.c++; registerHits.set(k, r);
  if (r.c > max) { bad(res, 429, 'Muitos registros a partir deste endereço. Tente mais tarde.'); return false; }
  return true;
}

app.post('/api/agent/register', (req, res) => {
  if (!throttle(req, res)) return;
  const b = req.body;
  const c = db.prepare('SELECT * FROM companies WHERE code=?').get(String(b.companyCode || '').trim().toUpperCase());
  if (!c) return bad(res, 404, 'Código de empresa não encontrado.');
  if (!b.termsAccepted) return bad(res, 400, 'É preciso aceitar os termos de uso.');
  const name = String(b.name || '').trim().slice(0, 60);
  if (!name) return bad(res, 400, 'Dê um nome para este computador.');
  const mode = b.accessMode === 'nao_assistido' ? 'nao_assistido' : 'permissao';
  let unattendedPass = null;
  if (mode === 'nao_assistido') {
    if (String(b.unattendedPassword || '').length < 8) return bad(res, 400, 'A senha fixa precisa ter pelo menos 8 caracteres.');
    unattendedPass = hashPassword(b.unattendedPassword);
  }
  const id = newDeviceId();
  const agentKey = crypto.randomBytes(32).toString('base64url');
  db.prepare(`INSERT INTO devices(id,name,company_id,os,access_mode,unattended_pass,agent_key_hash,quick,created_at,last_seen)
    VALUES(?,?,?,?,?,?,?,0,?,?)`).run(id, name, c.id, String(b.os || '').slice(0, 60), mode, unattendedPass, sha256(agentKey), now(), now());
  audit({ companyId: c.id, deviceId: id, actor: name, event: 'dispositivo_registrado', details: { modo: mode, os: b.os }, ip: ip(req) });
  res.json({ deviceId: id, agentKey, company: { name: c.name, code: c.code, verified: !!c.verified }, accessMode: mode, name });
});

app.get('/api/support-link/:token', (req, res) => {
  const l = db.prepare('SELECT l.*, c.name, c.verified FROM support_links l JOIN companies c ON c.id=l.company_id WHERE token=?').get(req.params.token);
  if (!l || l.expires_at < now() || l.used_at) return bad(res, 410, 'Este link de suporte expirou ou já foi usado. Peça um novo ao técnico.');
  res.json({ company: { name: l.name, verified: !!l.verified }, expiresAt: l.expires_at });
});

app.post('/api/agent/quick', (req, res) => {
  if (!throttle(req, res, 30)) return;
  let companyId = null;
  if (req.body.token) {
    const l = db.prepare('SELECT * FROM support_links WHERE token=?').get(String(req.body.token));
    if (!l || l.expires_at < now() || l.used_at) return bad(res, 410, 'Este link de suporte expirou ou já foi usado.');
    db.prepare('UPDATE support_links SET used_at=? WHERE token=?').run(now(), l.token);
    companyId = l.company_id;
  }
  const id = newDeviceId();
  const agentKey = crypto.randomBytes(32).toString('base64url');
  const name = String(req.body.name || 'QuickSupport').trim().slice(0, 60) || 'QuickSupport';
  db.prepare(`INSERT INTO devices(id,name,company_id,os,access_mode,agent_key_hash,quick,created_at,last_seen) VALUES(?,?,?,?, 'permissao', ?,1,?,?)`)
    .run(id, name, companyId, String(req.body.os || '').slice(0, 60), sha256(agentKey), now(), now());
  audit({ companyId, deviceId: id, actor: name, event: 'quicksupport_aberto', details: { via_link: !!req.body.token }, ip: ip(req) });
  if (companyId && req.body.reason) {
    db.prepare("INSERT INTO tickets(company_id,device_id,origin,reason,requester,created_at) VALUES(?,?,'link',?,?,?)")
      .run(companyId, id, String(req.body.reason).slice(0, 300), name, now());
    signaling.broadcastTechs(companyId, { type: 'queue-changed' });
  }
  res.json({ deviceId: id, agentKey });
});

// ---------------- daqui pra baixo: logado ----------------
app.use('/api', requireAuth);

app.get('/api/me', (req, res) => {
  const plan = getSetting('plan', 'equipe');
  res.json({ user: req.user, perms: Object.fromEntries(Object.keys(MATRIX).map((k) => [k, MATRIX[k][req.user.role]])), plan, planInfo: PLANS[plan], live: signaling.stats() });
});
app.post('/api/me/password', (req, res) => {
  const u = db.prepare('SELECT pass FROM users WHERE id=?').get(req.user.id);
  if (!verifyPassword(req.body.current || '', u.pass)) return bad(res, 400, 'Senha atual incorreta.');
  if (String(req.body.next || '').length < 8) return bad(res, 400, 'A nova senha precisa ter pelo menos 8 caracteres.');
  db.prepare('UPDATE users SET pass=?, must_change=0 WHERE id=?').run(hashPassword(req.body.next), req.user.id);
  audit({ companyId: req.user.company_id, userId: req.user.id, actor: req.user.name, event: 'senha_alterada', ip: ip(req) });
  res.json({ ok: true });
});
app.post('/api/me/device', (req, res) => {
  const d = db.prepare('SELECT * FROM devices WHERE id=?').get(String(req.body.deviceId || ''));
  if (!d || sha256(String(req.body.agentKey || '')) !== d.agent_key_hash) return bad(res, 400, 'Agente deste computador não reconhecido.');
  if (req.user.role !== 'admin' && d.company_id !== req.user.company_id) return bad(res, 403, 'Este computador é de outra empresa.');
  db.prepare('UPDATE users SET device_id=? WHERE id=?').run(d.id, req.user.id);
  db.prepare('UPDATE devices SET owner_user_id=? WHERE id=?').run(req.user.id, d.id);
  audit({ companyId: d.company_id, userId: req.user.id, actor: req.user.name, deviceId: d.id, event: 'dispositivo_alterado', details: { vinculado_a: req.user.email }, ip: ip(req) });
  res.json({ ok: true });
});
app.get('/api/permissions', (req, res) => res.json(MATRIX));

// ---------- empresas ----------
app.get('/api/companies', (req, res) => {
  const s = companyScope(req.user, 'id');
  res.json(db.prepare(`SELECT id,name,code,grp,cnpj,verified FROM companies WHERE ${s.sql} ORDER BY grp,name`).all(...s.args));
});
app.post('/api/companies', requirePerm('cobranca'), (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return bad(res, 400, 'Informe o nome da empresa.');
  const prefix = (String(req.body.prefix || 'DV').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'DV');
  const suffix = name.normalize('NFD').replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase().padEnd(3, 'X');
  const code = `${prefix}-${randomDigits(4)}-${suffix}`;
  const r = db.prepare('INSERT INTO companies(name,code,grp,cnpj,verified,created_at) VALUES(?,?,?,?,?,?)')
    .run(name, code, n(req.body.grp) || name, n(req.body.cnpj), req.body.cnpj ? 1 : 0, now());
  audit({ companyId: Number(r.lastInsertRowid), userId: req.user.id, actor: req.user.name, event: 'empresa_criada', details: { name, code }, ip: ip(req) });
  res.json({ id: Number(r.lastInsertRowid), code });
});

// ---------- dispositivos ----------
function deviceRow(d) {
  const st = signaling.status(d.id);
  const alerts = [];
  if (st === 'offline' && d.last_seen && now() - d.last_seen > 3 * 86400000) alerts.push(`Sem contato há ${Math.floor((now() - d.last_seen) / 86400000)} dias`);
  return { id: d.id, name: d.name, company_id: d.company_id, company: d.company_name, grp: d.grp, os: d.os, access_mode: d.access_mode,
    quick: !!d.quick, status: st, last_seen: d.last_seen, alerts };
}
app.get('/api/devices', requirePerm('gerir'), (req, res) => {
  const s = companyScope(req.user, 'd.company_id');
  const rows = db.prepare(`SELECT d.*, c.name company_name, c.grp FROM devices d LEFT JOIN companies c ON c.id=d.company_id
    WHERE ${s.sql} AND (d.quick=0 OR d.last_seen > ?) ORDER BY c.grp, c.name, d.name`).all(...s.args, now() - 86400000);
  res.json(rows.map(deviceRow));
});
app.get('/api/devices/recent', requirePerm('acessar'), (req, res) => {
  const rows = db.prepare(`SELECT d.*, c.name company_name, c.grp, MAX(s.started_at) last_access FROM sessions s JOIN devices d ON d.id=s.device_id
    LEFT JOIN companies c ON c.id=d.company_id WHERE s.tech_id=? GROUP BY d.id ORDER BY last_access DESC LIMIT 8`).all(req.user.id);
  res.json(rows.map((d) => ({ ...deviceRow(d), last_access: d.last_access })));
});
function loadScopedDevice(req, res) {
  const d = db.prepare('SELECT * FROM devices WHERE id=?').get(req.params.id);
  if (!d || !inCompany(req.user, d.company_id)) { bad(res, 404, 'Dispositivo não encontrado.'); return null; }
  return d;
}
app.patch('/api/devices/:id', requirePerm('gerir'), (req, res) => {
  const d = loadScopedDevice(req, res); if (!d) return;
  const name = req.body.name != null ? String(req.body.name).trim().slice(0, 60) : d.name;
  let companyId = d.company_id;
  if (req.body.company_id != null && req.user.role === 'admin') companyId = Number(req.body.company_id);
  let mode = d.access_mode, up = d.unattended_pass;
  if (req.body.access_mode === 'permissao') { mode = 'permissao'; }
  if (req.body.access_mode === 'nao_assistido') {
    if (req.body.unattendedPassword) {
      if (String(req.body.unattendedPassword).length < 8) return bad(res, 400, 'A senha fixa precisa ter pelo menos 8 caracteres.');
      up = hashPassword(req.body.unattendedPassword);
    }
    mode = 'nao_assistido';
  }
  db.prepare('UPDATE devices SET name=?, company_id=?, access_mode=?, unattended_pass=? WHERE id=?').run(name, companyId, mode, up, d.id);
  audit({ companyId, userId: req.user.id, actor: req.user.name, deviceId: d.id, event: 'dispositivo_alterado', details: { name, modo: mode }, ip: ip(req) });
  res.json({ ok: true });
});
app.delete('/api/devices/:id', requirePerm('gerir'), (req, res) => {
  const d = loadScopedDevice(req, res); if (!d) return;
  signaling.kickDevice(d.id);
  db.prepare("UPDATE devices SET company_id=NULL, agent_key_hash='removido', name=name||' (removido)' WHERE id=?").run(d.id);
  audit({ companyId: d.company_id, userId: req.user.id, actor: req.user.name, deviceId: d.id, event: 'dispositivo_removido', ip: ip(req) });
  res.json({ ok: true });
});

// ---------- equipe ----------
app.get('/api/users', requirePerm('convidar'), (req, res) => {
  const s = companyScope(req.user, 'u.company_id');
  const rows = db.prepare(`SELECT u.id,u.name,u.email,u.role,u.company_id,u.active,u.device_id,c.name company FROM users u
    LEFT JOIN companies c ON c.id=u.company_id WHERE ${s.sql} ORDER BY CASE u.role WHEN 'admin' THEN 0 WHEN 'gestor' THEN 1 ELSE 2 END, u.name`).all(...s.args);
  res.json(rows.map((u) => ({ ...u, presence: signaling.presence(u.id) })));
});
app.post('/api/users', requirePerm('convidar'), (req, res) => {
  const b = req.body;
  const role = ['admin', 'gestor', 'funcionario'].includes(b.role) ? b.role : 'funcionario';
  if (req.user.role === 'gestor' && role === 'admin') return bad(res, 403, 'Gestor convida apenas Gestor e Funcionário.');
  const companyId = req.user.role === 'gestor' ? req.user.company_id : n(b.company_id);
  if (role !== 'admin' && !companyId) return bad(res, 400, 'Escolha a empresa.');
  const email = String(b.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad(res, 400, 'E-mail inválido.');
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) return bad(res, 409, 'Já existe uma pessoa com este e-mail.');
  const temp = crypto.randomBytes(6).toString('base64url');
  const r = db.prepare('INSERT INTO users(name,email,pass,role,company_id,device_id,must_change,created_at) VALUES(?,?,?,?,?,?,1,?)')
    .run(String(b.name || email).trim().slice(0, 80), email, hashPassword(temp), role, companyId, n(b.device_id), now());
  audit({ companyId, userId: req.user.id, actor: req.user.name, event: 'pessoa_convidada', details: { email, perfil: role }, ip: ip(req) });
  res.json({ id: Number(r.lastInsertRowid), tempPassword: temp });
});
app.patch('/api/users/:id', requirePerm('convidar'), (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u || (req.user.role !== 'admin' && u.company_id !== req.user.company_id)) return bad(res, 404, 'Pessoa não encontrada.');
  if (u.id === req.user.id) return bad(res, 400, 'Você não pode alterar o próprio perfil.');
  if (req.user.role === 'gestor' && (u.role === 'admin' || req.body.role === 'admin')) return bad(res, 403, 'Sem permissão.');
  const role = ['admin', 'gestor', 'funcionario'].includes(req.body.role) ? req.body.role : u.role;
  const active = req.body.active == null ? u.active : (req.body.active ? 1 : 0);
  db.prepare('UPDATE users SET role=?, active=? WHERE id=?').run(role, active, u.id);
  audit({ companyId: u.company_id, userId: req.user.id, actor: req.user.name, event: 'perfil_alterado', details: { pessoa: u.email, perfil: role, ativo: !!active }, ip: ip(req) });
  res.json({ ok: true });
});

// ---------- fila de suporte ----------
app.get('/api/tickets', requirePerm('fila'), (req, res) => {
  const s = companyScope(req.user, 't.company_id');
  const rows = db.prepare(`SELECT t.*, d.name device_name, c.name company, u.name taken_name FROM tickets t
    LEFT JOIN devices d ON d.id=t.device_id LEFT JOIN companies c ON c.id=t.company_id LEFT JOIN users u ON u.id=t.taken_by
    WHERE ${s.sql} AND t.status IN ('aberto','em_atendimento') ORDER BY t.created_at`).all(...s.args);
  res.json(rows.map((t) => ({ ...t, device_status: signaling.status(t.device_id) })));
});
app.post('/api/tickets/:id/close', requirePerm('fila'), (req, res) => {
  const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(req.params.id);
  if (!t || !inCompany(req.user, t.company_id)) return bad(res, 404, 'Chamado não encontrado.');
  db.prepare("UPDATE tickets SET status=?, closed_at=?, taken_by=COALESCE(taken_by,?) WHERE id=?").run(req.body.status === 'cancelado' ? 'cancelado' : 'resolvido', now(), req.user.id, t.id);
  audit({ companyId: t.company_id, userId: req.user.id, actor: req.user.name, deviceId: t.device_id, event: 'chamado_encerrado', ip: ip(req) });
  signaling.broadcastTechs(t.company_id, { type: 'queue-changed' });
  res.json({ ok: true });
});
app.post('/api/support-links', requirePerm('fila'), (req, res) => {
  const companyId = req.user.role === 'admin' ? Number(req.body.company_id || req.user.company_id) : req.user.company_id;
  if (!companyId || !db.prepare('SELECT 1 FROM companies WHERE id=?').get(companyId)) return bad(res, 400, 'Escolha a empresa.');
  const token = `${randomDigits(2)}${crypto.randomBytes(4).toString('base64url')}`;
  const expires = now() + 30 * 60 * 1000;
  db.prepare('INSERT INTO support_links(token,company_id,created_by,created_at,expires_at) VALUES(?,?,?,?,?)').run(token, companyId, req.user.id, now(), expires);
  audit({ companyId, userId: req.user.id, actor: req.user.name, event: 'link_suporte_criado', ip: ip(req) });
  res.json({ token, url: `${req.protocol}://${req.get('host')}/s/${token}`, expiresAt: expires });
});
app.get('/api/team-presence', requirePerm('fila'), (req, res) => {
  const s = companyScope(req.user, 'company_id');
  const rows = db.prepare(`SELECT id,name,role FROM users WHERE active=1 AND role IN ('admin','gestor') AND (${s.sql} OR role='admin') ORDER BY name`).all(...s.args);
  res.json(rows.map((u) => ({ ...u, presence: signaling.presence(u.id) })));
});
app.get('/api/stats/today', requirePerm('fila'), (req, res) => {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const s = companyScope(req.user, 'company_id');
  const ss = db.prepare(`SELECT COUNT(*) c, AVG(ended_at-started_at) avg FROM sessions WHERE started_at>=? AND ended_at IS NOT NULL AND ${s.sql}`).get(start.getTime(), ...s.args);
  const tk = db.prepare(`SELECT COUNT(*) total, SUM(CASE WHEN (SELECT COUNT(*) FROM sessions x WHERE x.ticket_id=t.id)=1 THEN 1 ELSE 0 END) first FROM tickets t
    WHERE t.status='resolvido' AND t.closed_at>=? AND ${s.sql}`).get(start.getTime(), ...s.args);
  res.json({ sessions: ss.c, avgMinutes: ss.avg ? Math.round(ss.avg / 60000) : 0, firstContactPct: tk.total ? Math.round((100 * (tk.first || 0)) / tk.total) : null });
});

// ---------- auditoria, sessões e gravações ----------
function historyScope(user, alias) {
  if (user.role === 'admin') return { sql: '1=1', args: [] };
  if (user.role === 'gestor') return { sql: `${alias}.company_id=?`, args: [user.company_id ?? -1] };
  return { sql: `${alias}.device_id=?`, args: [user.device_id ?? '-'] };
}
const EVENT_LABEL = {
  login: 'Login', login_falhou: 'Login falhou', pedido_acesso: 'Pedido de acesso', acesso_permitido: 'Usuário permitiu o acesso',
  acesso_nao_assistido: 'Acesso não assistido', acesso_recusado: 'Acesso recusado', pedido_expirado: 'Pedido expirou', senha_incorreta: 'Senha incorreta',
  bloqueio_forca_bruta: 'Bloqueado: senhas erradas', sessao_encerrada: 'Sessão encerrada', arquivo_enviado: 'Arquivo enviado ao cliente',
  arquivo_recebido: 'Arquivo baixado do cliente', clipboard_enviado: 'Área de transferência enviada', gravacao_iniciada: 'Gravação iniciada', gravacao_salva: 'Gravação salva',
  dispositivo_registrado: 'Computador instalado', dispositivo_alterado: 'Computador alterado', dispositivo_removido: 'Computador removido', chamado_aberto: 'Chamado aberto',
  chamado_encerrado: 'Chamado encerrado', link_suporte_criado: 'Link de suporte criado', pessoa_convidada: 'Pessoa convidada', perfil_alterado: 'Perfil alterado',
  quicksupport_aberto: 'QuickSupport aberto', empresa_criada: 'Empresa criada', senha_alterada: 'Senha alterada', qualidade_alterada: 'Qualidade alterada',
  monitor_trocado: 'Tela trocada', relatorio_gerado: 'Relatório do atendimento', plano_alterado: 'Plano alterado',
};
app.get('/api/sessions', requirePerm('historico'), (req, res) => {
  const s = historyScope(req.user, 's');
  const rows = db.prepare(`SELECT s.*, d.name device_name, u.name tech_name FROM sessions s LEFT JOIN devices d ON d.id=s.device_id
    LEFT JOIN users u ON u.id=s.tech_id WHERE ${s.sql} ORDER BY s.started_at DESC LIMIT 200`).all(...s.args);
  const blocked = db.prepare(`SELECT a.ts started_at, a.device_id, a.actor tech_name, d.name device_name, a.details FROM audit a LEFT JOIN devices d ON d.id=a.device_id
    WHERE a.event='bloqueio_forca_bruta' AND ${s.sql.replace(/s\./g, 'a.')} ORDER BY a.ts DESC LIMIT 50`).all(...s.args);
  res.json({ sessions: rows.map((r) => ({ ...r, permissions: JSON.parse(r.permissions || '[]'), live: signaling.live.has(r.id) })), blocked });
});
app.get('/api/sessions/:id', requirePerm('historico'), (req, res) => {
  const s = historyScope(req.user, 's');
  const row = db.prepare(`SELECT s.*, d.name device_name, u.name tech_name FROM sessions s LEFT JOIN devices d ON d.id=s.device_id
    LEFT JOIN users u ON u.id=s.tech_id WHERE s.id=? AND ${s.sql}`).get(req.params.id, ...s.args);
  if (!row) return bad(res, 404, 'Sessão não encontrada.');
  const events = db.prepare('SELECT ts,event,actor,details,hash FROM audit WHERE session_id=? ORDER BY id').all(row.id)
    .map((e) => ({ ...e, label: EVENT_LABEL[e.event] || e.event }));
  const pedido = db.prepare("SELECT ts,event,actor,details,hash FROM audit WHERE device_id=? AND event='pedido_acesso' AND ts<=? ORDER BY id DESC LIMIT 1").get(row.device_id, row.started_at);
  if (pedido) events.unshift({ ...pedido, label: EVENT_LABEL.pedido_acesso });
  res.json({ ...row, permissions: JSON.parse(row.permissions || '[]'), events });
});
app.get('/api/audit', requirePerm('historico'), (req, res) => {
  const s = historyScope(req.user, 'a');
  const rows = db.prepare(`SELECT a.id,a.ts,a.actor,a.device_id,a.session_id,a.event,a.details,a.ip,a.hash, d.name device_name FROM audit a
    LEFT JOIN devices d ON d.id=a.device_id WHERE ${s.sql} ORDER BY a.id DESC LIMIT ?`).all(...s.args, Math.min(Number(req.query.limit) || 300, 2000));
  res.json(rows.map((r) => ({ ...r, label: EVENT_LABEL[r.event] || r.event })));
});
app.get('/api/audit/verify', requirePerm('cobranca'), (req, res) => res.json(verifyAudit()));
app.get('/api/audit/export.csv', requirePerm('historico'), (req, res) => {
  const s = historyScope(req.user, 'a');
  const rows = db.prepare(`SELECT a.ts,a.event,a.actor,a.device_id,d.name device_name,a.session_id,a.details,a.ip,a.hash FROM audit a
    LEFT JOIN devices d ON d.id=a.device_id WHERE ${s.sql} ORDER BY a.id`).all(...s.args);
  const q = (v) => { const t = v == null ? '' : String(v); return /^[=+\-@]/.test(t) ? `"'${t.replace(/"/g, '""')}"` : `"${t.replace(/"/g, '""')}"`; };
  const csv = ['quando;evento;quem;id_dispositivo;dispositivo;sessao;detalhes;ip;hash']
    .concat(rows.map((r) => [new Date(r.ts).toISOString(), EVENT_LABEL[r.event] || r.event, r.actor, r.device_id, r.device_name, r.session_id, r.details, r.ip, r.hash].map(q).join(';')));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="domma-view-auditoria-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('﻿' + csv.join('\n'));
});

function sessionForWrite(req, res) {
  const row = db.prepare('SELECT * FROM sessions WHERE id=?').get(req.params.id);
  if (!row || row.tech_id !== req.user.id) { bad(res, 404, 'Sessão não encontrada.'); return null; }
  return row;
}
app.post('/api/sessions/:id/recording', express.raw({ type: '*/*', limit: '500mb' }), (req, res) => {
  const row = sessionForWrite(req, res); if (!row) return;
  if (!JSON.parse(row.permissions || '[]').includes('gravar')) return bad(res, 403, 'O usuário não liberou a gravação.');
  if (!req.body || !req.body.length) return bad(res, 400, 'Gravação vazia.');
  const file = path.join(DATA_DIR, 'recordings', `${row.id}.webm.enc`);
  encryptToFile(req.body, file);
  db.prepare('UPDATE sessions SET recording=? WHERE id=?').run(path.basename(file), row.id);
  audit({ companyId: row.company_id, userId: req.user.id, actor: req.user.name, deviceId: row.device_id, sessionId: row.id, event: 'gravacao_salva',
    details: { bytes: req.body.length, sha256: sha256(req.body) }, ip: ip(req) });
  res.json({ ok: true });
});
app.get('/api/sessions/:id/recording', requirePerm('historico'), (req, res) => {
  const s = historyScope(req.user, 's');
  const row = db.prepare(`SELECT s.* FROM sessions s WHERE s.id=? AND ${s.sql}`).get(req.params.id, ...s.args);
  if (!row || !row.recording) return bad(res, 404, 'Sem gravação.');
  const buf = decryptFile(path.join(DATA_DIR, 'recordings', row.recording));
  res.setHeader('Content-Type', 'video/webm');
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(buf);
});
app.post('/api/sessions/:id/summary', (req, res) => {
  const row = sessionForWrite(req, res); if (!row) return;
  const summary = String(req.body.summary || '').slice(0, 4000);
  db.prepare('UPDATE sessions SET summary=? WHERE id=?').run(summary, row.id);
  audit({ companyId: row.company_id, userId: req.user.id, actor: req.user.name, deviceId: row.device_id, sessionId: row.id, event: 'relatorio_gerado', ip: ip(req) });
  res.json({ ok: true });
});

// ---------- planos ----------
app.get('/api/plans', (req, res) => res.json({ plans: PLANS, current: getSetting('plan', 'equipe') }));
app.post('/api/plans', requirePerm('cobranca'), (req, res) => {
  if (!PLANS[req.body.plan]) return bad(res, 400, 'Plano inválido.');
  setSetting('plan', req.body.plan);
  audit({ userId: req.user.id, actor: req.user.name, event: 'plano_alterado', details: { plano: req.body.plan }, ip: ip(req) });
  res.json({ ok: true });
});

app.use('/api', (req, res) => bad(res, 404, 'Rota não encontrada.'));

// ---------------- páginas ----------------
const pub = path.join(__dirname, '..', 'public');
app.use(express.static(pub, { extensions: ['html'], maxAge: '1h' }));
app.get('/s/:token', (req, res) => res.sendFile(path.join(pub, 'agente.html')));
app.get('/suporte', (req, res) => res.sendFile(path.join(pub, 'agente.html')));
app.use((req, res) => res.status(404).sendFile(path.join(pub, 'index.html')));

app.use((err, req, res, next) => { console.error(err); bad(res, 500, 'Erro interno.'); });

const server = http.createServer(app);
signaling.attach(server);
const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => console.log(`Domma View rodando em http://localhost:${PORT}`));
