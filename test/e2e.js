// Teste de ponta a ponta: instala o agente, técnico conecta, usuário aceita, vídeo chega,
// chat e arquivo trafegam, gravação é salva, sessão encerra e a auditoria confere.
// Uso: com o servidor rodando (ADMIN_EMAIL/ADMIN_PASSWORD definidos), `node test/e2e.js`.
const { chromium } = require('playwright');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const EMAIL = process.env.ADMIN_EMAIL || 'admin@domma.local';
const PASS = process.env.ADMIN_PASSWORD || 'domma-teste-123';
const SHOTS = process.env.SHOTS_DIR || null;

// Substitui o compartilhamento de tela por um canvas animado (o headless não tem tela).
const fakeScreen = () => {
  navigator.mediaDevices.getDisplayMedia = async () => {
    const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
    const g = c.getContext('2d'); let i = 0;
    setInterval(() => {
      g.fillStyle = '#2a3b63'; g.fillRect(0, 0, 1280, 720);
      g.fillStyle = '#fff'; g.fillRect(340, 160, 600, 360);
      g.fillStyle = '#1b1238'; g.font = 'bold 28px sans-serif'; g.fillText('Sistema de Laudos · Nova vistoria', 370, 210);
      g.fillStyle = '#5b3fe4'; g.fillRect(760, 450, 150, 44); g.fillStyle = '#fff'; g.font = '18px sans-serif'; g.fillText('Emitir laudo', 785, 478);
      g.fillStyle = '#e8e4ff'; g.fillText(`quadro ${i++}`, 20, 700);
    }, 33);
    return c.captureStream(30);
  };
};

(async () => {
  const browser = await chromium.launch();
  const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };
  try {
    // ---------- agente: instalador em 5 passos ----------
    const actx = await browser.newContext({ viewport: { width: 1100, height: 760 } });
    await actx.addInitScript(fakeScreen);
    const agent = await actx.newPage();
    agent.on('pageerror', (e) => console.error('[agente]', e.message));
    await agent.goto(`${BASE}/agente.html?empresa=ML-4821-ECV`);
    await agent.waitForSelector('text=Instalar o Domma View');
    await shot(agent, '02-instalador-1');
    await agent.check('#terms');
    await agent.click('#next');
    await agent.waitForSelector('text=Encontrado:');
    await agent.fill('#pcname', 'Recepção');
    await agent.click('#next');
    await agent.waitForSelector('text=Como o suporte vai entrar?');
    await agent.click('#next');
    await agent.waitForSelector('#next:not([disabled])', { timeout: 10000 });
    await agent.click('#next');
    await agent.waitForSelector('text=Este computador já pode receber suporte');
    const deviceId = (await agent.textContent('.big-id')).replace(/\D/g, '');
    assert.strictEqual(deviceId.length, 9, 'ID com 9 dígitos');
    await shot(agent, '03-instalador-pronto');
    await agent.click('#next');
    await agent.waitForSelector('text=Pronto para conectar');
    console.log('✓ agente instalado, ID', deviceId);

    // ---------- técnico ----------
    const tctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const techp = await tctx.newPage();
    techp.on('pageerror', (e) => console.error('[console]', e.message));
    await techp.goto(`${BASE}/app`);
    await techp.fill('input[name=email]', EMAIL);
    await techp.fill('input[name=password]', PASS);
    await techp.click('button:has-text("Entrar")');
    await techp.waitForSelector('text=Conecte-se a qualquer computador');
    await techp.waitForSelector('text=Pronto · conexão criptografada');
    await shot(techp, '01-inicio');
    await techp.fill('#pid', deviceId);
    await techp.click('#go');
    await techp.waitForSelector('text=Código de confirmação');
    const techCode = (await techp.textContent('.modal .mono')).trim();

    // ---------- usuário aceita ----------
    await agent.waitForSelector('text=quer acessar este computador');
    const agentCode = (await agent.textContent('.req-code')).trim();
    assert.strictEqual(agentCode, techCode, 'mesmo código de confirmação dos dois lados');
    await agent.check('input[data-p=gravar]');
    await shot(agent, '04-pedido-de-acesso');
    await agent.click('#allow');
    console.log('✓ pedido aceito com código', agentCode);

    // ---------- sessão ----------
    await techp.waitForSelector('#session');
    await techp.waitForFunction(() => { const v = document.querySelector('#rv'); return v && v.videoWidth > 0; }, null, { timeout: 20000 });
    console.log('✓ vídeo da tela remota chegando via WebRTC');
    await agent.waitForSelector('text=está conectado');

    await techp.fill('#ci', 'Já estou vendo. Faltam as fotos obrigatórias.');
    await techp.click('#cs');
    await agent.waitForSelector('text=Faltam as fotos obrigatórias');
    await agent.fill('#chat-in', 'O botão de emitir laudo não faz nada quando clico.');
    await agent.click('#chat-send');
    await techp.waitForSelector('text=O botão de emitir laudo');
    console.log('✓ chat nos dois sentidos');

    await techp.click('#t-rec');
    await agent.waitForSelector('text=está sendo gravada');
    await techp.waitForTimeout(2500);
    await shot(techp, '05-sessao');
    await techp.click('[data-tab=ia]');
    await techp.waitForSelector('text=O cliente relatou');
    await shot(techp, '06-sessao-ia');

    // arquivo técnico → usuário
    await techp.click('#t-files');
    const tmp = path.join(require('os').tmpdir(), 'Manual_fotos_vistoria.pdf');
    fs.writeFileSync(tmp, Buffer.alloc(300 * 1024, 7));
    await techp.setInputFiles('#f-pick', tmp);
    await techp.click('#f-send');
    await agent.waitForSelector('text=Manual_fotos_vistoria.pdf', { timeout: 15000 });
    await techp.waitForSelector('text=Concluído');
    console.log('✓ arquivo enviado pelo canal cifrado');
    // arquivo usuário → técnico
    const tmp2 = path.join(require('os').tmpdir(), 'log_erro_laudos.txt');
    fs.writeFileSync(tmp2, 'erro: fotos obrigatórias ausentes\n'.repeat(200));
    await agent.setInputFiles('#share', tmp2);
    await techp.waitForSelector('text=log_erro_laudos.txt');
    await techp.check('[data-r="0"]');
    const dl = techp.waitForEvent('download');
    await techp.click('#f-get');
    const d = await dl;
    assert.strictEqual(d.suggestedFilename(), 'log_erro_laudos.txt');
    await shot(techp, '07-arquivos');
    console.log('✓ arquivo baixado do computador remoto');
    await techp.click('#f-back');

    await techp.click('#t-end');
    await techp.waitForSelector('#session', { state: 'detached' });
    await agent.waitForSelector('text=Pronto para conectar');
    await techp.waitForTimeout(1500);
    console.log('✓ sessão encerrada');

    // ---------- console ----------
    await techp.goto(`${BASE}/app#/dispositivos`);
    await techp.waitForSelector('text=Recepção');
    await shot(techp, '08-dispositivos');
    await techp.goto(`${BASE}/app#/auditoria`);
    await techp.waitForSelector('text=Assistir gravação', { timeout: 10000 });
    await shot(techp, '09-auditoria');
    await techp.click('#vfy');
    await techp.waitForSelector('text=Registro íntegro');
    console.log('✓ gravação salva e auditoria íntegra');
    await techp.goto(`${BASE}/app#/equipe`);
    await techp.waitForSelector('text=Perfis de acesso');
    await shot(techp, '10-equipe');

    // ---------- fila + link de suporte + QuickSupport ----------
    await techp.goto(`${BASE}/app#/fila`);
    await techp.click('#lnew');
    await techp.waitForSelector('text=Enviar pelo WhatsApp');
    const link = (await techp.textContent('.note.mono')).trim();
    const qctx = await browser.newContext({ viewport: { width: 700, height: 900 } });
    await qctx.addInitScript(fakeScreen);
    const q = await qctx.newPage();
    await q.goto(link);
    await q.fill('#qname', 'Royal Vistorias');
    await q.fill('#qreason', 'Instalar certificado digital');
    await q.click('#qgo');
    await q.waitForSelector('text=Atenção a golpes');
    await shot(q, '11-quicksupport');
    await techp.waitForSelector('text=Instalar certificado digital', { timeout: 10000 });
    await shot(techp, '12-fila');
    console.log('✓ link de suporte → QuickSupport → fila');

    // ---------- força bruta: ID fora da empresa exige senha; 5 erros bloqueiam ----------
    const pctx = await browser.newContext();
    const p = await pctx.newPage();
    await p.goto(`${BASE}/suporte`);
    await p.waitForSelector('text=Pronto para conectar');
    const pid = (await p.textContent('.big-id')).replace(/\D/g, '');
    await techp.goto(`${BASE}/app#/inicio`);
    await techp.waitForSelector('#pid');
    for (let i = 1; i <= 5; i++) {
      await techp.fill('#pid', pid); await techp.fill('#ppw', 'errada-' + i); await techp.click('#go');
      await techp.waitForSelector(i < 5 ? `text=Senha incorreta (${i} de 5)` : 'text=Senha incorreta (5 de 5)');
      await techp.waitForTimeout(300);
    }
    await techp.fill('#ppw', 'qualquer'); await techp.click('#go');
    await techp.waitForSelector('text=bloqueado por 24 h');
    console.log('✓ bloqueio após 5 senhas erradas');

    // ---------- site + portal de cadastro + separação entre contas ----------
    const sctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const site = await sctx.newPage();
    await site.goto(BASE);
    await site.waitForSelector('text=Suporte remoto feito para o');
    await site.waitForSelector('#plans .plan-card');
    await shot(site, '13-site');
    await site.click('.topnav >> text=Criar conta');
    await site.waitForSelector('text=Sua conta Domma View em 2 minutos');
    await site.fill('input[name=accountName]', 'Rede Teste Vistorias');
    await site.fill('input[name=cnpj]', '11222333000181');
    await site.waitForSelector('text=CNPJ válido');
    await site.fill('input[name=firstUnit]', 'Loja Centro');
    await site.fill('input[name=name]', 'Maria Teste');
    await site.fill('input[name=phone]', '31999998888');
    await site.fill('input[name=email]', `maria.${Date.now()}@teste.local`);
    await site.fill('input[name=password]', 'senha-forte-123');
    await site.check('input[name=terms]');
    await shot(site, '14-cadastro');
    await site.click('button:has-text("Criar conta")');
    await site.waitForSelector('text=Conta criada');
    const newCode = (await site.textContent('.done-box .code')).trim();
    assert(/^RT-\d{4}-CEN$/.test(newCode), `código da nova empresa: ${newCode}`);
    await shot(site, '15-cadastro-ok');
    console.log('✓ portal de cadastro criou a conta, código', newCode);
    await site.click('text=Baixar o instalador');
    await site.waitForSelector('text=Instale o Domma View');
    await site.waitForSelector('#code-st >> text=Loja Centro');
    await shot(site, '16-download');
    const devs = await site.evaluate(() => fetch('/api/devices').then((r) => r.json()));
    const sess = await site.evaluate(() => fetch('/api/sessions').then((r) => r.json()));
    const comps = await site.evaluate(() => fetch('/api/companies').then((r) => r.json()));
    const aud = await site.evaluate(() => fetch('/api/audit').then((r) => r.json()));
    assert.strictEqual(devs.length, 0, 'conta nova não vê computadores de outra conta');
    assert.strictEqual(sess.sessions.length, 0, 'conta nova não vê sessões de outra conta');
    assert.deepStrictEqual(comps.map((c) => c.code), [newCode], 'conta nova só vê a própria empresa');
    assert(aud.every((e) => !String(e.actor).includes('Administrador')), 'auditoria só da própria conta');
    const blocked = await site.evaluate((id) => new Promise((res) => {
      const w = new WebSocket(`ws://${location.host}/ws`);
      w.onopen = () => w.send(JSON.stringify({ type: 'connect', deviceId: id }));
      w.onmessage = (e) => { const m = JSON.parse(e.data); if (m.type === 'error' || m.type === 'pending') { res(m); w.close(); } };
    }), deviceId);
    assert.strictEqual(blocked.type, 'error', 'sem senha não conecta em computador de outra conta');
    console.log('✓ contas separadas: a nova conta não vê nem acessa nada da outra');

    console.log('\nTODOS OS TESTES PASSARAM');
  } finally { await browser.close(); }
})().catch((e) => { console.error('FALHOU:', e); process.exit(1); });
