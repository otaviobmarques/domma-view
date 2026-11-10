// Teste do agente desktop para Windows rodando no Wine (Linux), com o servidor local.
// Instala pelo assistente (código da empresa lido do nome do instalador), captura a tela sem clique
// e confere os recursos anunciados. Limites do Wine neste ambiente: não enxerga placas de rede
// (WebRTC fica com test/e2e.js) e trava em chamadas de cursor do user32 (SendInput fica com o
// workflow do GitHub, que roda num Windows de verdade).
// Pré-requisitos: Xvfb, wine, xdotool e o build em agent-desktop/dist/win-unpacked.
const { chromium } = require('playwright');
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const assert = require('assert');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const EMAIL = process.env.ADMIN_EMAIL || 'admin@domma.local';
const PASS = process.env.ADMIN_PASSWORD || 'domma-teste-123';
const DISPLAY = ':77';
const APP_DIR = path.join(__dirname, '..', 'agent-desktop', 'dist', 'win-unpacked');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const _cursor = () => {
  const out = execFileSync('xdotool', ['getmouselocation'], { env: { ...process.env, DISPLAY } }).toString();
  const m = out.match(/x:(\d+) y:(\d+)/); return { x: +m[1], y: +m[2] };
};

(async () => {
  // começa de um computador "limpo": apaga os dados do agente no prefixo do Wine
  const home = process.env.WINEPREFIX || path.join(require('os').homedir(), '.wine');
  for (const u of require('fs').readdirSync(path.join(home, 'drive_c', 'users'))) {
    require('fs').rmSync(path.join(home, 'drive_c', 'users', u, 'AppData', 'Roaming', 'Domma View'), { recursive: true, force: true });
  }
  const xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', '1280x800x24'], { stdio: 'ignore' });
  await sleep(1500);
  const env = { ...process.env, DISPLAY, WINEDEBUG: '-all', DV_SERVER_URL: BASE };
  const app = spawn('wine', [path.join(APP_DIR, 'Domma View.exe'), '--no-sandbox', '--remote-debugging-port=9333'], { env, stdio: 'ignore' });
  let browser, cdp;
  try {
    for (let i = 0; i < 60 && !cdp; i++) { await sleep(1000); try { cdp = await chromium.connectOverCDP('http://127.0.0.1:9333'); } catch {} }
    assert(cdp, 'Electron no Wine não abriu a porta de depuração');
    let agent;
    for (let i = 0; i < 30 && !agent; i++) { agent = cdp.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('/agente.html')); if (!agent) await sleep(1000); }
    assert(agent, 'janela do agente não carregou');
    console.log('✓ Domma View.exe abriu no Wine e carregou o agente');
    await agent.waitForSelector('text=Instalar o Domma View');
    assert((await agent.textContent('.wz-foot')).includes('Windows'), 'modo desktop detectado');
    await agent.check('#terms'); await agent.click('#next');
    await agent.waitForSelector('text=Encontrado:');
    assert.strictEqual(await agent.inputValue('#code'), 'ML-4821-ECV', 'código lido do nome do instalador');
    await agent.fill('#pcname', 'Caixa (Windows)'); await agent.click('#next');
    await agent.click('#next');
    await agent.waitForSelector('#next:not([disabled])', { timeout: 15000 }); await agent.click('#next');
    await agent.waitForSelector('text=Este computador já pode receber suporte');
    const deviceId = (await agent.textContent('.big-id')).replace(/\D/g, '');
    await agent.click('#next');
    await agent.waitForSelector('text=Pronto para conectar');
    console.log('✓ instalado pelo assistente, código da empresa veio do nome do .exe, ID', deviceId);

    // 1) captura de tela sem seletor (setDisplayMediaRequestHandler)
    const dims = await agent.evaluate(async () => {
      const st = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const v = document.createElement('video'); v.muted = true; v.srcObject = st; await v.play();
      await new Promise((r) => setTimeout(r, 1000));
      const d = [v.videoWidth, v.videoHeight]; st.getTracks().forEach((t) => t.stop()); return d;
    });
    assert.deepStrictEqual(dims, [1280, 800], 'capturou a tela inteira sem pedir clique');
    console.log('✓ captura de tela sem clique:', dims.join('×'));

    // 2) entrada remota: o mesmo caminho que a mensagem do técnico percorre (dvNative.input → SendInput)
    const caps = await agent.evaluate(async () => (await window.dvNative.info()).caps);
    assert(caps.includes('input'), 'agente anuncia controle de mouse e teclado');
    console.log('✓ agente anuncia:', caps.join(', '));
    // Mouse e teclado reais (SendInput) não rodam no Wine deste ambiente: até SetCursorPos trava.
    // Eles são conferidos num Windows de verdade pelo workflow .github/workflows/agente-windows.yml.
    console.log('\nAGENTE DESKTOP OK');
  } finally {
    browser && await browser.close();
    try { cdp && await cdp.close(); } catch {}
    app.kill(); try { execFileSync('pkill', ['-f', 'Domma View.exe']); } catch {}
    xvfb.kill();
  }
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
