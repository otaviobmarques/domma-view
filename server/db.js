// Banco de dados (SQLite embutido no Node 22) + utilitários de segurança e auditoria.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(path.join(DATA_DIR, 'recordings'), { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'domma-view.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, cnpj TEXT, phone TEXT, plan TEXT DEFAULT 'equipe',
  status TEXT DEFAULT 'ativa', created_at INTEGER);

CREATE TABLE IF NOT EXISTS companies(
  id INTEGER PRIMARY KEY, account_id INTEGER REFERENCES accounts(id), name TEXT NOT NULL, code TEXT UNIQUE NOT NULL,
  grp TEXT, cnpj TEXT, verified INTEGER DEFAULT 0, created_at INTEGER);

CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, account_id INTEGER REFERENCES accounts(id), name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, pass TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','gestor','funcionario')),
  company_id INTEGER REFERENCES companies(id), device_id TEXT,
  active INTEGER DEFAULT 1, must_change INTEGER DEFAULT 0, created_at INTEGER);

CREATE TABLE IF NOT EXISTS devices(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, company_id INTEGER REFERENCES companies(id),
  os TEXT, access_mode TEXT DEFAULT 'permissao' CHECK(access_mode IN ('permissao','nao_assistido')),
  unattended_pass TEXT, agent_key_hash TEXT NOT NULL, quick INTEGER DEFAULT 0,
  owner_user_id INTEGER, last_seen INTEGER, created_at INTEGER);

CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY, account_id INTEGER, device_id TEXT, tech_id INTEGER, company_id INTEGER, ticket_id INTEGER,
  started_at INTEGER, ended_at INTEGER, permissions TEXT, unattended INTEGER DEFAULT 0,
  files INTEGER DEFAULT 0, recording TEXT, summary TEXT, ended_by TEXT, route TEXT);

CREATE TABLE IF NOT EXISTS audit(
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, account_id INTEGER, company_id INTEGER, user_id INTEGER, actor TEXT,
  device_id TEXT, session_id TEXT, event TEXT NOT NULL, details TEXT, ip TEXT,
  prev_hash TEXT NOT NULL, hash TEXT NOT NULL);

CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit
BEGIN SELECT RAISE(ABORT, 'auditoria e somente-insercao'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit
BEGIN SELECT RAISE(ABORT, 'auditoria e somente-insercao'); END;

CREATE TABLE IF NOT EXISTS tickets(
  id INTEGER PRIMARY KEY, company_id INTEGER, device_id TEXT, origin TEXT, reason TEXT, requester TEXT,
  status TEXT DEFAULT 'aberto', taken_by INTEGER, created_at INTEGER, taken_at INTEGER, closed_at INTEGER);

CREATE TABLE IF NOT EXISTS support_links(
  token TEXT PRIMARY KEY, company_id INTEGER, created_by INTEGER,
  created_at INTEGER, expires_at INTEGER, used_at INTEGER);

CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
`);

// Migração de bancos criados antes das contas (multiempresa)
for (const [t, c] of [['devices', 'service_key_hash TEXT'], ['companies', 'account_id INTEGER'], ['users', 'account_id INTEGER'], ['sessions', 'account_id INTEGER'], ['audit', 'account_id INTEGER']]) {
  try { db.exec(`ALTER TABLE ${t} ADD COLUMN ${c}`); } catch {}
}
db.exec('CREATE INDEX IF NOT EXISTS audit_account ON audit(account_id, id)');
const accountOfCompany = (id) => (id == null ? null : db.prepare('SELECT account_id FROM companies WHERE id=?').get(id)?.account_id ?? null);
const accountOfUser = (id) => (id == null ? null : db.prepare('SELECT account_id FROM users WHERE id=?').get(id)?.account_id ?? null);

// ---------- segredos persistidos (gerados no primeiro start) ----------
function secret(name, envName) {
  if (process.env[envName]) return Buffer.from(process.env[envName], 'hex');
  const file = path.join(DATA_DIR, `${name}.key`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
}
const SESSION_SECRET = secret('session', 'SESSION_SECRET');
const RECORDING_KEY = secret('recording', 'RECORDING_KEY');

// ---------- helpers ----------
const n = (v) => (v === undefined ? null : v);
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(pw), salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [, saltHex, keyHex] = stored.split('$');
  const key = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), 64);
  const ref = Buffer.from(keyHex, 'hex');
  return ref.length === key.length && crypto.timingSafeEqual(ref, key);
}

function randomDigits(len) {
  let s = String(crypto.randomInt(1, 10));
  while (s.length < len) s += crypto.randomInt(0, 10);
  return s;
}
function newDeviceId() {
  for (;;) {
    const id = randomDigits(9);
    if (!db.prepare('SELECT 1 FROM devices WHERE id=?').get(id)) return id;
  }
}
// Senha temporária no formato do protótipo: 7xk9-p2qm
function tempPassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  const pick = () => abc[crypto.randomInt(0, abc.length)];
  return Array.from({ length: 4 }, pick).join('') + '-' + Array.from({ length: 4 }, pick).join('');
}

// ---------- auditoria imutável com hash encadeado ----------
const lastHashStmt = db.prepare('SELECT hash FROM audit ORDER BY id DESC LIMIT 1');
const insertAudit = db.prepare(`INSERT INTO audit(ts,account_id,company_id,user_id,actor,device_id,session_id,event,details,ip,prev_hash,hash)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);

function auditPayload(r) {
  return JSON.stringify([r.ts, r.account_id, r.company_id, r.user_id, r.actor, r.device_id, r.session_id, r.event, r.details, r.ip, r.prev_hash]);
}
function audit(e) {
  const row = {
    ts: Date.now(), company_id: n(e.companyId), user_id: n(e.userId), actor: n(e.actor),
    device_id: n(e.deviceId), session_id: n(e.sessionId), event: e.event,
    details: e.details == null ? null : (typeof e.details === 'string' ? e.details : JSON.stringify(e.details)),
    ip: n(e.ip),
  };
  row.account_id = e.accountId ?? accountOfCompany(row.company_id) ?? accountOfUser(row.user_id);
  const last = lastHashStmt.get();
  row.prev_hash = last ? last.hash : 'GENESIS';
  row.hash = sha256(auditPayload(row));
  insertAudit.run(row.ts, row.account_id, row.company_id, row.user_id, row.actor, row.device_id, row.session_id,
    row.event, row.details, row.ip, row.prev_hash, row.hash);
  return row;
}
// A cadeia é única para o servidor todo; a conta só recebe o resultado e a própria contagem.
function verifyAudit(accountId) {
  let prev = 'GENESIS', count = 0, mine = 0;
  for (const r of db.prepare('SELECT * FROM audit ORDER BY id').all()) {
    if (r.prev_hash !== prev || sha256(auditPayload(r)) !== r.hash) return { ok: false, brokenAt: r.account_id === accountId ? r.id : null, count: mine };
    prev = r.hash; count++; if (r.account_id === accountId) mine++;
  }
  return { ok: true, count: mine };
}

// ---------- gravações criptografadas (AES-256-GCM) ----------
function encryptToFile(buf, file) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', RECORDING_KEY, iv);
  const enc = Buffer.concat([c.update(buf), c.final()]);
  fs.writeFileSync(file, Buffer.concat([iv, c.getAuthTag(), enc]));
}
function decryptFile(file) {
  const raw = fs.readFileSync(file);
  const d = crypto.createDecipheriv('aes-256-gcm', RECORDING_KEY, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]);
}

function getSetting(k, def) { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? r.value : def; }
function setSetting(k, v) { db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v)); }

module.exports = {
  db, DATA_DIR, SESSION_SECRET, n, sha256, hashPassword, verifyPassword, randomDigits, newDeviceId,
  tempPassword, audit, verifyAudit, accountOfCompany, encryptToFile, decryptFile, getSetting, setSetting,
};
