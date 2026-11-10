// Sessões de login (cookie assinado), perfis e regras de permissão.
const crypto = require('crypto');
const { db, SESSION_SECRET } = require('./db');

const COOKIE = 'dv_session';
const TTL = 12 * 60 * 60 * 1000; // 12 h

function sign(data) { return crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url'); }

function issueToken(userId) {
  const body = Buffer.from(JSON.stringify({ uid: userId, exp: Date.now() + TTL })).toString('base64url');
  return `${body}.${sign(body)}`;
}
function readToken(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = sign(body);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() ? p.uid : null;
  } catch { return null; }
}
function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function userFromRequest(req) {
  const uid = readToken(parseCookies(req.headers.cookie)[COOKIE]);
  if (!uid) return null;
  const u = db.prepare(`SELECT u.id,u.name,u.email,u.role,u.company_id,u.account_id,u.device_id,u.must_change,c.name company_name,
      a.name account_name, a.plan FROM users u LEFT JOIN companies c ON c.id=u.company_id LEFT JOIN accounts a ON a.id=u.account_id
    WHERE u.id=? AND u.active=1 AND (a.status IS NULL OR a.status='ativa')`).get(uid);
  return u || null;
}
function setCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${TTL / 1000}${secure}`);
}
function clearCookie(res) { res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`); }

// ---------- permissões (seção 5 do descritivo) ----------
// valores: 'todas' | 'empresa' | 'propria' | true | false
const MATRIX = {
  acessar:        { admin: 'todas', gestor: 'empresa', funcionario: false, label: 'Acessar máquinas remotamente' },
  nao_assistido:  { admin: 'todas', gestor: 'empresa', funcionario: false, label: 'Acesso não assistido' },
  arquivos:       { admin: true,    gestor: 'empresa', funcionario: false, label: 'Transferir arquivos' },
  terminal:       { admin: true,    gestor: 'empresa', funcionario: false, label: 'Terminal, reiniciar e tela preta' },
  fila:           { admin: 'todas', gestor: 'empresa', funcionario: false, label: 'Atender a fila de suporte' },
  instalar:       { admin: true,    gestor: true,      funcionario: true,  label: 'Instalar o agente na própria máquina' },
  pedir_suporte:  { admin: true,    gestor: true,      funcionario: true,  label: 'Pedir suporte e receber conexão' },
  historico:      { admin: 'todas', gestor: 'empresa', funcionario: 'propria', label: 'Ver histórico e gravações' },
  gerir:          { admin: 'todas', gestor: 'empresa', funcionario: false, label: 'Gerir máquinas e grupos' },
  convidar:       { admin: 'todas', gestor: 'empresa', funcionario: false, label: 'Convidar pessoas' },
  cobranca:       { admin: true,    gestor: false,     funcionario: false, label: 'Plano e cobrança' },
};

function can(user, perm) { return !!(user && MATRIX[perm] && MATRIX[perm][user.role]); }
function inCompany(user, companyId) {
  if (!user || companyId == null) return false; // computador sem empresa (QuickSupport avulso) só entra com senha
  if (user.role === 'admin') return db.prepare('SELECT account_id FROM companies WHERE id=?').get(companyId)?.account_id === user.account_id;
  if (user.role === 'gestor') return companyId === user.company_id;
  return false;
}
// Filtro SQL de empresas visíveis
function companyScope(user, col = 'company_id') {
  if (user.role === 'admin') return { sql: `${col} IN (SELECT id FROM companies WHERE account_id=?)`, args: [user.account_id ?? -1] };
  return { sql: `${col}=?`, args: [user.company_id ?? -1] };
}

function requireAuth(req, res, next) {
  const u = userFromRequest(req);
  if (!u) return res.status(401).json({ error: 'Faça login para continuar.' });
  req.user = u; next();
}
function requirePerm(perm) {
  return (req, res, next) => (can(req.user, perm) ? next() : res.status(403).json({ error: 'Seu perfil não tem permissão para isso.' }));
}

module.exports = {
  issueToken, readToken, parseCookies, userFromRequest, setCookie, clearCookie,
  MATRIX, can, inCompany, companyScope, requireAuth, requirePerm, COOKIE,
};
