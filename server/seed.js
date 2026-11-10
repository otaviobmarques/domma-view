// Dados iniciais: empresas da rede e um Administrador. Roda só com o banco vazio.
const crypto = require('crypto');
const { db, hashPassword, audit, setSetting } = require('./db');

function seed() {
  if (db.prepare('SELECT COUNT(*) c FROM users').get().c > 0) return;
  const t = Date.now();
  const companies = [
    ['Master Laudo · Matriz', 'ML-4821-MTZ', 'Master Laudo', 1],
    ['ECV Contagem', 'ML-4821-ECV', 'Franquias MG', 1],
    ['ECV Betim', 'ML-4822-BET', 'Franquias MG', 1],
    ['ECV Uberlândia', 'ML-4823-UDI', 'Franquias MG', 1],
    ['RedBox', 'RB-1150-RBX', 'RedBox', 1],
    ['Operação iFood', 'IF-3301-IFD', 'iFood', 0],
  ];
  const ins = db.prepare('INSERT INTO companies(name,code,grp,verified,created_at) VALUES(?,?,?,?,?)');
  for (const c of companies) ins.run(c[0], c[1], c[2], c[3], t);

  const email = (process.env.ADMIN_EMAIL || 'admin@domma.local').toLowerCase();
  const pass = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  const matriz = db.prepare("SELECT id FROM companies WHERE code='ML-4821-MTZ'").get().id;
  db.prepare("INSERT INTO users(name,email,pass,role,company_id,must_change,created_at) VALUES(?,?,?,'admin',?,?,?)")
    .run(process.env.ADMIN_NAME || 'Administrador', email, hashPassword(pass), matriz, process.env.ADMIN_PASSWORD ? 0 : 1, t);
  setSetting('plan', 'equipe');
  audit({ companyId: matriz, actor: 'sistema', event: 'empresa_criada', details: { seed: true } });

  console.log('\n================ Domma View · primeiro acesso ================');
  console.log(`  Administrador: ${email}`);
  if (!process.env.ADMIN_PASSWORD) console.log(`  Senha inicial: ${pass}   (troque depois do primeiro login)`);
  console.log('  Códigos de empresa para o instalador:');
  for (const c of companies) console.log(`    ${c[1]}  ${c[0]}`);
  console.log('==============================================================\n');
}
module.exports = { seed };
