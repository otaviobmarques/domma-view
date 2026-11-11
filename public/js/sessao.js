// Sessão remota do técnico (seção 7.5) e transferência de arquivos (7.6).
const DVSession = (() => {
  const { esc, $, $$, api, toast, modal, logo, fmtId, fmtBytes, fmtDur } = DV;
  const NATIVE = 'Este computador usa o agente web, que só transmite a tela. Instale o Domma View para Windows nele para liberar este recurso.';
  const NEEDS_SERVICE = 'Exige o serviço do Windows do Domma View (instalado junto com o instalador para Windows).';
  let s = null;

  function open(info, wsClient, iceServers, opts = {}) {
    s = {
      ...info, ws: wsClient, iceServers, started: Date.now(), chat: [], tab: 'chat', panel: true, quality: 'auto',
      remoteFiles: [], localFiles: [], transfers: {}, recording: null, stats: {}, filesOpen: !!opts.openFiles, sysinfo: info.sysinfo || null,
    };
    const el = document.createElement('div');
    el.className = 'session'; el.id = 'session';
    document.body.appendChild(el);
    s.el = el;
    s.desktop = info.desktop || null;
    s.fpsCount = 0; s.fps = 0;
    render();
    if (s.relay) { // ninguém logado: só o serviço do Windows, imagem e controle pelo servidor
      s.timer = setInterval(tick, 1000);
      window.addEventListener('keydown', escListener);
      return;
    }
    s.pc = new RTCPeerConnection({ iceServers });
    s.pc.ontrack = (e) => { s.stream = e.streams[0]; const v = $('#rv'); if (v) { v.srcObject = s.stream; } renderScreenState(); };
    s.pc.onicecandidate = (e) => e.candidate && s.ws.send({ type: 'signal', sid: s.sid, data: { candidate: e.candidate } });
    s.pc.ondatachannel = (e) => {
      s.ch = DVChannel.wrap(e.channel, {
        onMessage: onData,
        onProgress: (p) => { trackProgress(p); },
        onFile: (f) => {
          const a = document.createElement('a'); a.href = URL.createObjectURL(f.blob); a.download = f.name; a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 60000);
          s.transfers[f.id] = { ...(s.transfers[f.id] || {}), name: f.name, size: f.size, done: f.size, dir: 'in', finished: true };
          s.ws.send({ type: 'session-event', sid: s.sid, event: 'arquivo_recebido', details: { nome: f.name, bytes: f.size } });
          renderFiles();
        },
      });
      e.channel.onopen = () => { if (s && s.quality !== 'auto') s.ch.send({ t: 'quality', v: s.quality }); };
    };
    s.timer = setInterval(tick, 1000);
    window.addEventListener('keydown', escListener);
  }

  function escListener(e) { if (e.key === 'Escape' && s && s.filesOpen) { s.filesOpen = false; render(); } }

  async function onSignal(m) {
    if (!s || m.sid !== s.sid) return;
    if (m.data.sdp) {
      await s.pc.setRemoteDescription(m.data.sdp);
      if (m.data.sdp.type === 'offer') {
        const ans = await s.pc.createAnswer();
        await s.pc.setLocalDescription(ans);
        s.ws.send({ type: 'signal', sid: s.sid, data: { sdp: s.pc.localDescription } });
      }
    } else if (m.data.candidate) { try { await s.pc.addIceCandidate(m.data.candidate); } catch {} }
  }

  function onData(m) {
    if (m.t === 'chat') { s.chat.push({ me: false, text: String(m.text).slice(0, 2000), ts: Date.now() }); if (s.tab === 'chat') renderPanel(); else flashTab('chat'); }
    if (m.t === 'files-list') { s.remoteFiles = (m.files || []).map((f) => ({ ...f, sel: false })); renderFiles(); toast('O usuário compartilhou arquivos.'); }
    if (m.t === 'hello' && m.sysinfo) { s.sysinfo = m.sysinfo; if (s.tab === 'sistema') renderPanel(); }
    if (m.t === 'rect' && m.rect) s.rect = m.rect; // tela capturada pelo agente, em pixels reais (para o controle pelo serviço)
  }

  // ---------- serviço do Windows: tela segura (UAC, bloqueio, login), Ctrl+Alt+Del, bloqueio de teclado ----------
  const svcView = () => !!(s && (s.relay || (s.service && s.desktop && s.desktop.secure)));
  async function onService(m) {
    if (!s || m.sid !== s.sid) return;
    if (m.type === 'svc-frame') {
      const c = $('#sf'); if (!c) return;
      try {
        const bin = atob(m.data); const buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        const bmp = await createImageBitmap(new Blob([buf], { type: 'image/jpeg' }));
        if (c.width !== bmp.width || c.height !== bmp.height) { c.width = bmp.width; c.height = bmp.height; }
        c.getContext('2d').drawImage(bmp, 0, 0);
        if (s.lastFrame) s.lastFrame.close();
        s.lastFrame = bmp;
        s.fpsCount++;
        if (!s.gotFrame) { s.gotFrame = true; renderScreenState(); }
      } catch {}
    } else if (m.type === 'svc-desktop') {
      const was = svcView();
      if (m.gone) s.service = false;
      s.desktop = { name: m.name, secure: !!m.secure };
      if (svcView() !== was) {
        toast(svcView() ? 'Tela segura do Windows (UAC, bloqueio ou login): imagem e controle pelo serviço.' : 'De volta à área de trabalho.');
        render();
      }
    } else if (m.type === 'priv-result') {
      if (!m.ok) toast(m.error || 'O serviço não conseguiu executar.', true);
      else if (m.op === 'sas') toast('Ctrl+Alt+Del enviado.');
      else if (m.op === 'block') toast(s.blocked ? 'Teclado e mouse do cliente bloqueados. Ctrl+Alt+Del no computador desbloqueia.' : 'Teclado e mouse do cliente liberados.');
      else if (m.op === 'reboot') toast('Reiniciando o computador remoto…');
    }
  }
  function priv(op, extra = {}) { s.ws.send({ type: 'priv', sid: s.sid, op, ...extra }); }

  function flashTab(t) { const b = $(`.tabs [data-tab=${t}]`); if (b) b.textContent = b.textContent.replace(/ •$/, '') + ' •'; }

  function has(p) { return s.perms.includes(p); }

  function render() {
    const tb = (id, label, { on = false, dis = false, title = '' } = {}) => `<button class="tb ${on ? 'on' : ''}" id="${id}" ${dis ? 'disabled' : ''} title="${esc(title)}">${label}</button>`;
    s.el.innerHTML = `
      <div class="s-top">
        <div class="who">${logo(22)}<div><b>${esc(s.device.name)}</b><span>${fmtId(s.device.id)} · <span id="clock">00:00:00</span></span></div></div>
        ${tb('t-mon', 'Trocar tela', { dis: !!s.relay, title: s.relay ? 'Na tela de login o serviço mostra todos os monitores' : 'Pede ao usuário para escolher outra tela ou monitor' })}
        ${tb('t-q', `Qualidade · ${{ auto: 'auto', max: 'máxima', fast: 'rápida' }[s.quality]}`, { dis: !!s.relay })}
        ${svc() ? tb('t-cad', 'Ctrl+Alt+Del', { dis: !has('controlar'), title: has('controlar') ? 'Ctrl+Alt+Del de verdade, enviado pelo serviço do Windows' : 'O usuário não liberou o controle' })
          : tb('t-cad', 'Ctrl+Shift+Esc', { dis: !ctl('sas'), title: ctl('sas') ? 'Abre o Gerenciador de Tarefas. Para o Ctrl+Alt+Del de verdade, o computador precisa do serviço do Windows.' : NATIVE })}
        ${tb('t-lock', s.blocked ? 'Teclado do cliente bloqueado' : 'Bloquear teclado do cliente', { on: !!s.blocked, dis: !(svc() && has('controlar')), title: svc() ? 'Bloqueia teclado e mouse de quem está na frente do computador. O Ctrl+Alt+Del físico sempre desbloqueia.' : s.native ? NEEDS_SERVICE : NATIVE })}
        ${tb('t-black', s.black ? 'Tela preta ligada' : 'Tela preta', { on: !!s.black, dis: !!s.relay || !ctl('blackscreen'), title: ctl('blackscreen') ? 'Esconde a tela para quem está na frente do computador' : NATIVE })}
        ${tb('t-rec', s.recording ? 'Gravando' : 'Gravar', { on: !!s.recording, dis: !has('gravar'), title: has('gravar') ? '' : 'O usuário não liberou a gravação' })}
        ${tb('t-ann', 'Anotar na tela', { dis: true, title: 'Em desenvolvimento' })}
        ${tb('t-rb', 'Reiniciar', { dis: !((svc() || (s.native && (s.caps || []).includes('reboot'))) && has('reiniciar')), title: !(svc() || s.native) ? NATIVE : has('reiniciar') ? (svc() ? 'Reinicia o computador. O serviço volta sozinho e você pode entrar pela tela de login (acesso não assistido).' : 'Reinicia o computador remoto.') : 'O usuário não liberou reiniciar' })}
        ${tb('t-panel', 'Painel', { on: s.panel })}
        ${tb('t-files', 'Arquivos', { on: s.filesOpen, dis: !!s.relay || !has('arquivos'), title: s.relay ? 'Arquivos precisam de alguém logado no computador' : has('arquivos') ? '' : 'O usuário não liberou arquivos' })}
        ${tb('t-full', 'Tela cheia')}
        <span class="stats" id="stats">conectando…</span>
        <button class="tb end" id="t-end">Encerrar</button>
      </div>
      <div class="rec-band ${s.recording ? 'on' : ''}">● Gravando a sessão · o cliente foi avisado e a gravação vai para a Auditoria</div>
      ${svcView() ? `<div class="svc-band">🛡 ${s.relay ? 'Ninguém logado: tela de login do Windows' : 'Tela segura do Windows (UAC, bloqueio ou Ctrl+Alt+Del)'} · imagem e controle pelo serviço do Windows</div>` : ''}
      <div class="s-body ${s.panel ? '' : 'nopanel'}">
        <div class="screen" id="screen">
          <video id="rv" autoplay playsinline muted></video>
          <canvas id="sf" class="svc-frame"></canvas>
          <div class="wait" id="wait">${s.relay ? 'Conectando ao serviço do Windows…' : `${s.unattended ? 'Acesso não assistido · ' : ''}Aguardando o vídeo do computador remoto…`}</div>
          ${canInput() ? '<div class="ctrl-hint" id="hint">Controle ativo: clique na tela para usar mouse e teclado do computador remoto.</div>'
            : has('controlar') ? '<div class="ctrl-hint" id="hint">Só visualização: este computador usa o agente web. Instale o Domma View para Windows nele para controlar mouse e teclado.</div>' : ''}
        </div>
        <aside class="s-panel" id="panel"></aside>
      </div>
      ${s.filesOpen ? '<div id="files-ov" style="position:absolute;inset:0;background:var(--bg);color:var(--ink);overflow:auto;z-index:5"></div>' : ''}`;
    if (s.stream) $('#rv').srcObject = s.stream;
    if (s.lastFrame) { const c = $('#sf'); c.width = s.lastFrame.width; c.height = s.lastFrame.height; c.getContext('2d').drawImage(s.lastFrame, 0, 0); }
    renderScreenState(); renderPanel(); renderFiles(); bindTop(); bindInput();
    setTimeout(() => { const h = $('#hint'); h && h.remove(); }, 8000);
  }

  function renderScreenState() {
    const sv = svcView(), ready = sv ? s.gotFrame : !!s.stream;
    const w = $('#wait'); if (w) w.style.display = ready ? 'none' : '';
    const v = $('#rv'); if (v) v.style.display = !sv && s.stream ? '' : 'none';
    const c = $('#sf'); if (c) c.style.display = sv && s.gotFrame ? '' : 'none';
  }

  // Controle remoto: só com agente desktop e com a permissão "Controlar mouse e teclado" liberada
  function ctl(cap) { return !!(s.native && (s.caps || []).includes(cap) && has('controlar')); }
  function svc() { return !!s.service; }
  function canInput() { return has('controlar') && (svcView() || (svc() && s.rect) || ctl('input')); }
  // Na tela segura/login, o mouse e o teclado vão pelo serviço (SYSTEM). Na área de trabalho, também
  // vão pelo serviço quando ele existe (alcança janelas de administrador); senão, pelo canal direto do agente.
  function sendIn(m) {
    if (svcView()) return priv('input', { m });
    if (svc() && s.rect && m.x != null) {
      return priv('input', { m: { ...m, ax: s.rect.x + m.x * (s.rect.width - 1), ay: s.rect.y + m.y * (s.rect.height - 1) } });
    }
    if (svc() && s.rect) return priv('input', { m });
    s.ch && s.ch.open && s.ch.send({ t: 'in', ...m });
  }
  function bindInput() {
    if (!canInput()) return;
    const v = $('#screen'); if (!v) return;
    v.tabIndex = 0; v.style.outline = 'none';
    const held = new Set();
    const pos = (e) => {
      const t = svcView() ? $('#sf') : $('#rv'); if (!t) return null;
      const r = t.getBoundingClientRect(), vw = svcView() ? t.width : t.videoWidth, vh = svcView() ? t.height : t.videoHeight;
      if (!vw || !vh) return null;
      const k = Math.min(r.width / vw, r.height / vh), w = vw * k, h = vh * k;
      const x = (e.clientX - (r.left + (r.width - w) / 2)) / w, y = (e.clientY - (r.top + (r.height - h) / 2)) / h;
      return x < 0 || y < 0 || x > 1 || y > 1 ? null : { x: +x.toFixed(5), y: +y.toFixed(5) };
    };
    let last = null, raf = 0;
    v.addEventListener('pointermove', (e) => {
      const p = pos(e); if (!p) return; last = p;
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; sendIn({ k: 'move', ...last }); });
    });
    v.addEventListener('pointerdown', (e) => {
      const p = pos(e); if (!p) return;
      e.preventDefault(); v.focus({ preventScroll: true }); v.setPointerCapture(e.pointerId);
      sendIn({ k: 'down', b: e.button, ...p });
    });
    v.addEventListener('pointerup', (e) => { sendIn({ k: 'up', b: e.button, ...(pos(e) || last || { x: 0, y: 0 }) }); });
    v.addEventListener('contextmenu', (e) => e.preventDefault());
    v.addEventListener('dblclick', (e) => e.preventDefault());
    v.addEventListener('wheel', (e) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
      const clamp = (n) => Math.max(-1200, Math.min(1200, Math.round(n)));
      sendIn({ k: 'wheel', dx: clamp(e.deltaX * unit * 1.2), dy: clamp(-e.deltaY * unit * 1.2) });
    }, { passive: false });
    v.addEventListener('keydown', (e) => {
      if (!e.code) return;
      e.preventDefault(); e.stopPropagation();
      held.add(e.code); sendIn({ k: 'key', code: e.code, down: true });
    });
    v.addEventListener('keyup', (e) => {
      if (!e.code) return;
      e.preventDefault(); held.delete(e.code); sendIn({ k: 'key', code: e.code, down: false });
    });
    // Ao sair da tela, solta teclas presas (ex.: Alt+Tab no computador do técnico)
    v.addEventListener('blur', () => { for (const code of held) sendIn({ k: 'key', code, down: false }); held.clear(); });
  }

  function bindTop() {
    const on = (id, fn) => { const el = $('#' + id); el && el.addEventListener('click', fn); };
    on('t-end', () => end(true));
    on('t-panel', () => { s.panel = !s.panel; render(); });
    on('t-full', () => { document.fullscreenElement ? document.exitFullscreen() : $('#screen').requestFullscreen?.(); });
    on('t-mon', () => { s.ch && s.ch.send({ t: 'monitor' }); toast(s.native ? 'Trocando para a próxima tela…' : 'Pedimos ao usuário para escolher a outra tela.'); });
    on('t-cad', () => {
      if (svc()) { priv('sas'); return; }
      sendIn({ k: 'combo', codes: ['ControlLeft', 'ShiftLeft', 'Escape'] });
      s.ws.send({ type: 'session-event', sid: s.sid, event: 'atalho_enviado', details: { atalho: 'Ctrl+Shift+Esc' } }); $('#screen')?.focus();
    });
    on('t-lock', () => { s.blocked = !s.blocked; priv('block', { on: s.blocked }); render(); });
    on('t-black', () => {
      s.black = !s.black; s.ch && s.ch.send({ t: 'black', on: s.black });
      s.ws.send({ type: 'session-event', sid: s.sid, event: 'tela_preta', details: { ligada: s.black } }); render();
    });
    on('t-rb', () => {
      if (!confirm(`Reiniciar ${s.device.name} agora? A sessão cai e, com acesso não assistido, o computador volta para a lista em cerca de 1 minuto.`)) return;
      if (svc()) priv('reboot');
      else { s.ch && s.ch.send({ t: 'reboot' }); s.ws.send({ type: 'session-event', sid: s.sid, event: 'reinicio_solicitado' }); }
    });
    on('t-q', () => {
      s.quality = { auto: 'max', max: 'fast', fast: 'auto' }[s.quality];
      s.ch && s.ch.send({ t: 'quality', v: s.quality });
      s.ws.send({ type: 'session-event', sid: s.sid, event: 'qualidade_alterada', details: { qualidade: s.quality } });
      $('#t-q').textContent = `Qualidade · ${{ auto: 'auto', max: 'máxima', fast: 'rápida' }[s.quality]}`;
    });
    on('t-rec', () => (s.recording ? stopRecording() : startRecording()));
    on('t-files', () => { s.filesOpen = !s.filesOpen; render(); });
  }

  // ---------- painel lateral: Chat · Sistema · Domma IA ----------
  function renderPanel() {
    const p = $('#panel'); if (!p) return;
    const tabs = `<div class="tabs">${['chat', 'sistema', 'ia'].map((t) => `<button data-tab="${t}" class="${s.tab === t ? 'on' : ''}">${{ chat: 'Chat', sistema: 'Sistema', ia: 'Domma IA' }[t]}</button>`).join('')}</div>`;
    let body = '', foot = '<div></div>';
    if (s.tab === 'chat' && s.relay) {
      body = '<div class="small" style="color:#a79fd0">Ninguém está logado neste computador, então não há chat nem arquivos. Faça login pela tela ao lado; quando o usuário entrar, abra uma nova sessão para ter tudo.</div>';
    } else if (s.tab === 'chat') {
      body = s.chat.length ? s.chat.map((m) => `<div class="msg ${m.me ? 'me' : ''}">${esc(m.text)}</div>`).join('') : '<div class="muted small" style="color:#a79fd0">Converse com quem está no computador. Tudo fica no registro do atendimento.</div>';
      foot = `<div><div class="chat-in"><input id="ci" placeholder="Escreva para o cliente" maxlength="2000"><button class="btn primary sm" id="cs">Enviar</button></div>
        ${has('clipboard') ? '<div style="padding:0 10px 10px"><button class="tb" id="clip" style="width:100%">Enviar minha área de transferência</button></div>' : ''}</div>`;
    } else if (s.tab === 'sistema') {
      const i = s.sysinfo || {};
      const rows = [['Sistema', i.os], ['Navegador', i.browser], ['CPU', i.cpu], ['Memória', i.memory], ['Tela', i.screen], ['Disco', i.disk], ['Idioma', i.language], ['Fuso', i.timezone], ['Agente', i.agent], ['Rota', s.stats.route], ['Permissões', s.perms.join(', ')]];
      body = `<dl class="kv">${rows.filter((r) => r[1]).map((r) => `<dt>${r[0]}</dt><dd>${esc(r[1])}</dd>`).join('')}</dl>
        <p class="small" style="color:#a79fd0;margin-top:14px">IP, antivírus e uso de disco detalhado vêm com o agente nativo.</p>`;
    } else {
      const sum = summarize();
      body = `<div class="ia-card"><div class="eyebrow">Domma IA</div><p style="margin:8px 0">${esc(sum.text)}</p>${sum.tip ? `<p class="small" style="color:#c9c0f5">Sugestão: ${esc(sum.tip)}</p>` : ''}</div>
        <button class="tb" id="report" style="width:100%;margin-top:12px;padding:9px">Gerar relatório do atendimento</button>
        <p class="small" style="color:#a79fd0">Resumo automático a partir do chat e dos eventos da sessão.</p>`;
    }
    p.innerHTML = tabs + `<div class="pane" id="pane">${body}</div>` + foot;
    $$('.tabs button', p).forEach((b) => b.addEventListener('click', () => { s.tab = b.dataset.tab; renderPanel(); }));
    const pane = $('#pane'); pane.scrollTop = pane.scrollHeight;
    const send = () => {
      const i = $('#ci'); const text = i.value.trim(); if (!text || !s.ch) return;
      s.ch.send({ t: 'chat', text }); s.chat.push({ me: true, text, ts: Date.now() }); renderPanel(); $('#ci').focus();
    };
    $('#cs') && $('#cs').addEventListener('click', send);
    $('#ci') && $('#ci').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
    $('#clip') && $('#clip').addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (!text) return toast('Sua área de transferência está vazia.');
        s.ch.send({ t: 'clip', text }); s.ws.send({ type: 'session-event', sid: s.sid, event: 'clipboard_enviado', details: { caracteres: text.length } });
        toast('Texto enviado. O usuário confirma a cópia do lado dele.');
      } catch { toast('O navegador não liberou a leitura da área de transferência.', true); }
    });
    $('#report') && $('#report').addEventListener('click', report);
  }

  const TIPS = [
    [/impress|imprim|spooler/i, 'conferir fila de impressão e driver da impressora; reiniciar o spooler se travado.'],
    [/foto|anex|upload|imagem/i, 'verificar se todas as fotos obrigatórias foram anexadas e se estão no formato e tamanho aceitos.'],
    [/senha|login|acesso negado|bloquead/i, 'confirmar usuário, redefinir a senha pelo fluxo oficial e checar bloqueio por tentativas.'],
    [/lent|trav|congel/i, 'checar uso de CPU/memória e programas abertos; reiniciar o aplicativo afetado.'],
    [/internet|rede|conex|wi-?fi/i, 'testar a conexão (cabo/Wi-Fi), DNS e se outros sites abrem normalmente.'],
    [/certificado|token|assinatura/i, 'conferir validade do certificado digital e se o driver do token está instalado.'],
  ];
  function summarize() {
    const dur = fmtDur(Date.now() - s.started);
    const fromUser = s.chat.filter((m) => !m.me).map((m) => m.text);
    const all = s.chat.map((m) => m.text).join(' ');
    const files = Object.values(s.transfers).filter((t) => t.finished);
    const tip = (TIPS.find(([re]) => re.test(all)) || [])[1];
    const text = `Atendimento em ${s.device.name} há ${dur}. ${fromUser.length ? `O cliente relatou: "${fromUser[0].slice(0, 140)}".` : 'Ainda sem relato do cliente no chat.'} ` +
      `${s.chat.length} mensagens, ${files.length} arquivo(s) transferido(s)${s.recording ? ', sessão sendo gravada' : ''}.`;
    return { text, tip };
  }
  async function report() {
    const sum = summarize();
    const lines = [
      `Relatório do atendimento · Domma View`, `Computador: ${s.device.name} (${fmtId(s.device.id)})`, `Empresa: ${s.device.company || '—'}`,
      `Início: ${new Date(s.started).toLocaleString('pt-BR')} · Duração: ${fmtDur(Date.now() - s.started)}`, `Permissões: ${s.perms.join(', ')}`, '',
      `Resumo: ${sum.text}`, sum.tip ? `Próximo passo sugerido: ${sum.tip}` : '', '',
      'Chat:', ...s.chat.map((m) => `  ${m.me ? 'Técnico' : 'Cliente'}: ${m.text}`),
      '', 'Arquivos:', ...Object.values(s.transfers).filter((t) => t.finished).map((t) => `  ${t.dir === 'in' ? '⬇' : '⬆'} ${t.name} (${fmtBytes(t.size)})`),
    ].filter((x) => x !== undefined);
    const text = lines.join('\n');
    try { await api(`/api/sessions/${s.sid}/summary`, { body: { summary: `${sum.text}${sum.tip ? ' Sugestão: ' + sum.tip : ''}` } }); } catch {}
    modal(`<div class="mh"><h2>Relatório do atendimento</h2><div class="muted small">O resumo foi salvo na Auditoria desta sessão.</div></div>
      <div class="mb"><textarea rows="14" readonly class="mono" style="font-size:12px">${esc(text)}</textarea></div>
      <div class="mf"><button class="btn" data-close>Fechar</button><button class="btn primary" id="cp">Copiar</button></div>`,
    { onMount: (el) => $('#cp', el).addEventListener('click', () => { navigator.clipboard.writeText(text); toast('Relatório copiado'); }) });
  }

  // ---------- arquivos em duas colunas ----------
  function renderFiles() {
    const ov = $('#files-ov'); if (!ov) return;
    const trs = Object.entries(s.transfers).slice(-8).reverse();
    ov.innerHTML = `<div style="padding:26px 32px;max-width:1100px;margin:0 auto">
      <div class="between" style="margin-bottom:18px"><div class="row"><button class="link" id="f-back">← Voltar para a sessão</button><h1 style="margin:0 0 0 14px">Arquivos · ${esc(s.device.name)}</h1></div>
      <span class="muted small">Tudo vai pelo canal cifrado da sessão.</span></div>
      <div class="files-grid">
        <div class="card"><div class="eyebrow">Este computador</div><div class="muted small mono" style="margin:4px 0 8px">Arquivos escolhidos por você</div>
          ${s.localFiles.map((f, i) => `<label class="file-row"><input type="checkbox" data-l="${i}" ${f.sel ? 'checked' : ''} style="width:16px;height:16px;accent-color:var(--violet)"> ${esc(f.file.name)}<span class="sz">${fmtBytes(f.file.size)}</span></label>`).join('') || '<div class="muted small" style="padding:10px 0">Nenhum arquivo escolhido.</div>'}
          <div class="between" style="margin-top:12px"><label class="btn sm">Escolher arquivos<input type="file" id="f-pick" multiple hidden></label>
          <button class="btn primary sm" id="f-send" ${s.localFiles.some((f) => f.sel) ? '' : 'disabled'}>Enviar para o cliente →</button></div></div>
        <div class="card"><div class="eyebrow">Computador remoto</div><div class="muted small mono" style="margin:4px 0 8px">Arquivos que o usuário compartilhou</div>
          ${s.remoteFiles.map((f, i) => `<label class="file-row"><input type="checkbox" data-r="${i}" ${f.sel ? 'checked' : ''} style="width:16px;height:16px;accent-color:var(--violet)"> ${esc(f.name)}<span class="sz">${fmtBytes(f.size)}</span></label>`).join('') || '<div class="muted small" style="padding:10px 0">Peça no chat para o usuário clicar em “Compartilhar arquivos com o técnico”.</div>'}
          <div style="margin-top:12px;text-align:right"><button class="btn primary sm" id="f-get" ${s.remoteFiles.some((f) => f.sel) ? '' : 'disabled'}>← Baixar para mim</button></div></div>
      </div>
      <div class="card" style="margin-top:16px"><h3>Transferências</h3>
        ${trs.map(([, t]) => `<div class="between small"><span>${esc(t.name)} ${t.dir === 'in' ? '→ este computador' : '→ remoto'}</span><span class="mono muted">${t.finished ? 'Concluído' : `${fmtBytes(t.done)} de ${fmtBytes(t.size)}${t.speed ? ` · ${fmtBytes(t.speed)}/s` : ''}`}</span></div>
          <div class="progress ${t.finished ? 'done' : ''}"><i style="width:${t.size ? Math.round((100 * t.done) / t.size) : 100}%"></i></div>`).join('') || '<div class="muted small">Nada por enquanto.</div>'}
      </div></div>`;
    $('#f-back').addEventListener('click', () => { s.filesOpen = false; render(); });
    $('#f-pick').addEventListener('change', (e) => { for (const file of e.target.files) s.localFiles.push({ file, sel: true }); renderFiles(); });
    $$('[data-l]', ov).forEach((c) => c.addEventListener('change', () => { s.localFiles[c.dataset.l].sel = c.checked; renderFiles(); }));
    $$('[data-r]', ov).forEach((c) => c.addEventListener('change', () => { s.remoteFiles[c.dataset.r].sel = c.checked; renderFiles(); }));
    $('#f-send').addEventListener('click', async () => {
      const list = s.localFiles.filter((f) => f.sel); s.localFiles.forEach((f) => { f.sel = false; });
      for (const f of list) {
        const id = Math.random().toString(36).slice(2);
        s.transfers[id] = { name: f.file.name, size: f.file.size, done: 0, dir: 'out', t0: Date.now() };
        renderFiles();
        await s.ch.sendFile(f.file, id);
        s.transfers[id].finished = true; s.transfers[id].done = f.file.size;
        s.ws.send({ type: 'session-event', sid: s.sid, event: 'arquivo_enviado', details: { nome: f.file.name, bytes: f.file.size } });
        renderFiles();
      }
    });
    $('#f-get').addEventListener('click', () => {
      s.remoteFiles.filter((f) => f.sel).forEach((f) => { s.transfers[f.id] = { name: f.name, size: f.size, done: 0, dir: 'in', t0: Date.now() }; s.ch.send({ t: 'file-get', id: f.id }); f.sel = false; });
      renderFiles();
    });
  }
  let lastFilesRender = 0;
  function trackProgress(p) {
    const t = s.transfers[p.id] || (s.transfers[p.id] = { name: p.name, size: p.size, done: 0, dir: p.dir, t0: Date.now() });
    t.done = p.done; t.speed = p.done / Math.max(0.2, (Date.now() - t.t0) / 1000);
    if (Date.now() - lastFilesRender > 200) { lastFilesRender = Date.now(); renderFiles(); }
  }

  // ---------- gravação (MediaRecorder no lado do técnico, enviada cifrada ao servidor) ----------
  function startRecording() {
    const src = s.relay ? ($('#sf') && $('#sf').captureStream(5)) : s.stream;
    if (!src || (s.relay && !s.gotFrame)) return toast('Aguarde o vídeo começar.', true);
    const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t));
    if (!type) return toast('Este navegador não grava vídeo.', true);
    const rec = new MediaRecorder(src, { mimeType: type, videoBitsPerSecond: 1_500_000 });
    const parts = [];
    rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
    rec.onstop = async () => {
      const blob = new Blob(parts, { type: 'video/webm' });
      try { await api(`/api/sessions/${rec.sid}/recording`, { body: blob }); toast('Gravação salva na Auditoria.'); }
      catch (e) { toast(`Gravação não foi salva: ${e.message}`, true); }
    };
    rec.sid = s.sid;
    rec.start(2000);
    s.recording = rec;
    s.ws.send({ type: 'recording', sid: s.sid, on: true });
    render();
  }
  function stopRecording() {
    if (!s.recording) return;
    s.recording.stop(); s.recording = null;
    s.ws.send({ type: 'recording', sid: s.sid, on: false });
    render();
  }

  async function tick() {
    if (!s) return;
    const c = $('#clock'); if (c) c.textContent = fmtDur(Date.now() - s.started);
    s.fps = s.fpsCount; s.fpsCount = 0;
    if (svcView()) {
      const el = $('#stats'); if (el) el.textContent = `${s.fps} fps · serviço do Windows · via servidor`;
      if (s.relay) return;
    }
    try {
      const st = await s.pc.getStats();
      let rtt, fps, pair, locType;
      st.forEach((r) => {
        if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || r.selected)) pair = r;
        if (r.type === 'inbound-rtp' && r.kind === 'video') fps = r.framesPerSecond;
      });
      if (pair) {
        rtt = pair.currentRoundTripTime;
        const lc = st.get(pair.localCandidateId), rc = st.get(pair.remoteCandidateId);
        locType = (lc && lc.candidateType === 'relay') || (rc && rc.candidateType === 'relay') ? 'Relay' : 'Direto · P2P';
        if (s.stats.route !== locType) { s.stats.route = locType; s.ws.send({ type: 'session-event', sid: s.sid, event: 'rota', details: { route: locType } }); }
      }
      const el = $('#stats');
      if (el && !svcView()) el.textContent = pair ? `${rtt != null ? Math.round(rtt * 1000) + ' ms' : '—'}  ${fps ? Math.round(fps) + ' fps' : ''}  ${locType}` : 'conectando…';
    } catch {}
  }

  function end(notify, by) {
    if (!s) return;
    if (s.recording) stopRecording();
    if (notify) s.ws.send({ type: 'end', sid: s.sid });
    clearInterval(s.timer);
    try { s.pc && s.pc.close(); } catch {}
    s.el.remove();
    window.removeEventListener('keydown', escListener);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    const sid = s.sid; s = null;
    if (!notify) toast(by === 'usuario' ? 'O usuário encerrou a sessão.' : 'A sessão foi encerrada.');
    DVSession.onEnd && DVSession.onEnd(sid);
  }

  return { open, onSignal, onService, end, get active() { return s; }, onEnd: null };
})();
