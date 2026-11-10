// Domma View para Windows: agente desktop que recebe suporte remoto.
// Carrega o agente do servidor da Domma e acrescenta o que o navegador não pode:
// captura de tela sem clique, mouse e teclado remotos, início com o Windows, tela preta e reinício.
const { app, BrowserWindow, Tray, Menu, ipcMain, session, desktopCapturer, screen, nativeImage, dialog, shell, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

const IS_WIN = process.platform === 'win32';
const input = IS_WIN ? safeRequire('./input-win') : null;
function safeRequire(m) { try { return require(m); } catch (e) { console.error('input', e); return null; } }

// ---------- configuração ----------
const BUILD_CFG = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch { return {}; } })();
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
function readSettings() { try { return JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8')); } catch { return {}; } }
function writeSettings(s) { fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true }); fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(s, null, 2)); }
function serverUrl() {
  const u = process.env.DV_SERVER_URL || readSettings().serverUrl || BUILD_CFG.serverUrl || 'http://localhost:3000';
  return u.replace(/\/+$/, '');
}
const origin = () => new URL(serverUrl()).origin;
function trusted(url) {
  try { const u = new URL(url); return u.origin === origin() || u.protocol === 'file:'; } catch { return false; }
}
function fromServer(e) { try { return new URL(e.senderFrame.url).origin === origin(); } catch { return false; } }

let win = null, tray = null, bar = null, blackWins = [], quitting = false;
let screenIndex = 0, currentDisplayId = null, inSession = false, sleepBlock = null;

if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', () => showWindow());
app.setAppUserModelId('br.com.domma.view');

// ---------- janela principal ----------
function createWindow(hidden) {
  win = new BrowserWindow({
    width: 640, height: 800, minWidth: 420, minHeight: 560, show: !hidden, title: 'Domma View',
    icon: path.join(__dirname, 'build', 'icon.png'), autoHideMenuBar: true, backgroundColor: '#efedf8',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.removeMenu();
  loadAgent();
  win.webContents.on('did-fail-load', (e, code, desc, url, isMain) => {
    if (isMain && code !== -3) win.loadFile(path.join(__dirname, 'offline.html'), { query: { server: serverUrl(), error: desc } });
  });
  win.webContents.on('will-navigate', (e, url) => { if (!trusted(url)) { e.preventDefault(); shell.openExternal(url); } });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault(); win.hide();
    if (!readSettings().trayHintShown) {
      tray && tray.displayBalloon && tray.displayBalloon({ title: 'Domma View continua ativo', content: 'O suporte ainda pode pedir acesso. Abra pelo ícone perto do relógio.' });
      writeSettings({ ...readSettings(), trayHintShown: true });
    }
  });
}
function loadAgent() { win.loadURL(`${serverUrl()}/agente.html?native=1`); }
function showWindow() { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); }

// ---------- captura de tela sem seletor (o agente desktop escolhe a tela) ----------
function setupCapture() {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!trusted(request.frame ? request.frame.url : request.securityOrigin || '')) return callback({});
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    if (!sources.length) return callback({});
    const src = sources[screenIndex % sources.length];
    currentDisplayId = src.display_id;
    callback({ video: src });
  });
  const allowed = new Set(['notifications', 'clipboard-sanitized-write', 'clipboard-read', 'media', 'display-capture', 'fullscreen']);
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb, details) => cb(allowed.has(perm) && trusted(details.requestingUrl || wc.getURL())));
  session.defaultSession.setPermissionCheckHandler((wc, perm, requestingOrigin) => allowed.has(perm) && trusted(requestingOrigin || ''));
}

function capturedRect() {
  const displays = screen.getAllDisplays();
  const d = displays.find((x) => String(x.id) === String(currentDisplayId)) || screen.getPrimaryDisplay();
  return IS_WIN ? screen.dipToScreenRect(null, d.bounds) : { x: d.bounds.x * d.scaleFactor, y: d.bounds.y * d.scaleFactor, width: d.bounds.width * d.scaleFactor, height: d.bounds.height * d.scaleFactor };
}

// ---------- IPC (só aceita chamadas vindas do servidor configurado) ----------
function setupIpc() {
  const caps = ['monitors'].concat(input ? ['input', 'sas', 'blackscreen', 'reboot'] : []);
  ipcMain.handle('dv:info', (e) => {
    if (!fromServer(e)) return null;
    const cpus = os.cpus();
    return {
      caps,
      sysinfo: {
        os: IS_WIN ? `Windows ${os.release()}` : `${os.type()} ${os.release()}`, hostname: os.hostname(), user: os.userInfo().username,
        cpu: cpus.length ? `${cpus[0].model.trim()} · ${cpus.length} núcleos` : null, memory: `${(os.totalmem() / 1073741824).toFixed(1).replace('.', ',')} GB (${(os.freemem() / 1073741824).toFixed(1).replace('.', ',')} GB livres)`,
        screen: screen.getAllDisplays().map((d) => `${d.size.width * d.scaleFactor}×${d.size.height * d.scaleFactor}`).join(' + '),
        agent: `Domma View ${app.getVersion()} (desktop)`, uptime: `${Math.round(os.uptime() / 3600)} h ligado`,
      },
    };
  });
  ipcMain.on('dv:input', (e, m) => {
    if (!input || !inSession || !fromServer(e) || !m || typeof m !== 'object') return;
    try { input.handle(m, capturedRect()); } catch (err) { console.error('input', err); }
  });
  ipcMain.handle('dv:next-screen', (e) => { if (fromServer(e)) screenIndex++; return screenIndex; });
  ipcMain.on('dv:blackscreen', (e, on) => { if (fromServer(e)) setBlack(!!on && inSession); });
  ipcMain.on('dv:reboot', (e) => {
    if (!fromServer(e) || !inSession || !IS_WIN) return;
    execFile('shutdown', ['/r', '/t', '5', '/c', 'Reinício solicitado pelo suporte (Domma View)'], () => {});
  });
  ipcMain.on('dv:session-bar', (e, info) => { if (fromServer(e)) sessionBar(info); });
  ipcMain.on('dv:attention', (e, soft) => {
    if (!fromServer(e) || !win) return;
    if (soft && win.isVisible()) { win.flashFrame(true); return; }
    showWindow(); win.flashFrame(true);
  });
  ipcMain.handle('dv:setup-code', (e) => (fromServer(e) ? readSetupCode() : null));
  ipcMain.on('dv:version', (e) => { e.returnValue = app.getVersion(); });
  ipcMain.handle('dv:get-server', () => serverUrl());
  ipcMain.handle('dv:set-server', (e, url) => {
    if (!String(e.senderFrame.url).startsWith('file:')) return false; // só a tela local de configuração troca o servidor
    try { const u = new URL(String(url)); if (!/^https?:$/.test(u.protocol)) throw 0; writeSettings({ ...readSettings(), serverUrl: u.origin }); loadAgent(); return true; } catch { return false; }
  });
  ipcMain.on('dv:retry', () => loadAgent());
  ipcMain.on('dv:bar-end', () => { win && win.webContents.send('dv:end-request'); });
}

// O instalador grava o código da empresa (vindo do nome do arquivo ou de /EMPRESA=) ao lado do .exe
function readSetupCode() {
  for (const f of [path.join(path.dirname(process.execPath), 'setup-code.txt'), path.join(app.getPath('userData'), 'setup-code.txt')]) {
    try { const m = fs.readFileSync(f, 'utf8').toUpperCase().match(/[A-Z]{2}-\d{4}-[A-Z]{3}/); if (m) return m[0]; } catch {}
  }
  return null;
}

// ---------- barra fixa no topo durante o acesso (anti-golpe: sempre visível) ----------
function sessionBar(info) {
  inSession = !!info;
  if (!info) {
    if (bar) { bar.destroy(); bar = null; }
    if (sleepBlock != null) { powerSaveBlocker.stop(sleepBlock); sleepBlock = null; }
    setBlack(false);
    tray && tray.setToolTip('Domma View · pronto');
    return;
  }
  if (sleepBlock == null) sleepBlock = powerSaveBlocker.start('prevent-display-sleep');
  tray && tray.setToolTip(`Domma View · ${info.name} conectado`);
  const d = screen.getPrimaryDisplay().workArea;
  const w = 460, h = 46;
  if (!bar) {
    bar = new BrowserWindow({
      width: w, height: h, x: Math.round(d.x + (d.width - w) / 2), y: d.y + 6, frame: false, resizable: false, movable: true, alwaysOnTop: true,
      skipTaskbar: true, focusable: true, transparent: true, hasShadow: false, show: false,
      webPreferences: { preload: path.join(__dirname, 'preload-bar.js'), contextIsolation: true, sandbox: true },
    });
    bar.setAlwaysOnTop(true, 'screen-saver');
    if (IS_WIN && input) input.excludeFromCapture(bar.getNativeWindowHandle()); // o técnico não vê a barra
    bar.loadFile(path.join(__dirname, 'bar.html'), { query: { name: info.name, company: info.company, unattended: info.unattended ? '1' : '' } });
    bar.once('ready-to-show', () => bar.showInactive());
  }
}

// ---------- tela preta: cobre os monitores para quem está na frente, mas fica fora da captura ----------
function setBlack(on) {
  blackWins.forEach((b) => b.destroy()); blackWins = [];
  if (!on || !IS_WIN || !input) return;
  for (const d of screen.getAllDisplays()) {
    const b = new BrowserWindow({
      x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height, frame: false, show: false, focusable: false,
      skipTaskbar: true, alwaysOnTop: true, backgroundColor: '#000000', fullscreenable: false, resizable: false, movable: false,
      webPreferences: { sandbox: true, contextIsolation: true },
    });
    b.setAlwaysOnTop(true, 'screen-saver');
    b.setIgnoreMouseEvents(true); // os cliques do técnico atravessam a tela preta
    input.excludeFromCapture(b.getNativeWindowHandle());
    b.loadFile(path.join(__dirname, 'black.html'));
    b.once('ready-to-show', () => b.showInactive());
    blackWins.push(b);
  }
  bar && bar.setAlwaysOnTop(true, 'screen-saver', 1);
}

// ---------- ícone perto do relógio ----------
function setupTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'build', 'tray.png'));
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.setToolTip('Domma View · pronto');
  const menu = () => Menu.buildFromTemplate([
    { label: 'Abrir Domma View', click: showWindow },
    { label: 'Pedir suporte', click: () => { showWindow(); win.webContents.send('dv:ask-support'); } },
    { type: 'separator' },
    { label: 'Iniciar com o Windows', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (i) => setAutostart(i.checked) },
    { label: `Servidor: ${new URL(serverUrl()).host}`, enabled: false },
    { type: 'separator' },
    { label: 'Sair', click: quit },
  ]);
  tray.setContextMenu(menu());
  tray.on('click', showWindow);
  tray.on('right-click', () => tray.setContextMenu(menu()));
}
function setAutostart(on) {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: on, path: process.execPath, args: ['--hidden'] });
}
async function quit() {
  if (inSession) {
    const r = await dialog.showMessageBox({ type: 'warning', buttons: ['Encerrar e sair', 'Cancelar'], defaultId: 1, cancelId: 1, title: 'Domma View', message: 'Há um técnico conectado. Sair encerra o atendimento.' });
    if (r.response !== 0) return;
  }
  quitting = true; app.quit();
}

app.whenReady().then(() => {
  const s = readSettings();
  if (!s.autostartConfigured) { setAutostart(true); writeSettings({ ...s, autostartConfigured: true }); }
  setupCapture();
  setupIpc();
  createWindow(process.argv.includes('--hidden'));
  setupTray();
});
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', (e) => { if (!quitting) e.preventDefault(); });
