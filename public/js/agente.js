// Agente Domma View no navegador: instalador (5 passos), QuickSupport e tela do usuário.
(() => {
  const { esc, $, $$, api, toast, modal, logo, fmtId, fmtBytes, socket, sysinfo } = DV;
  const root = $('#root');
  const STORE = 'dv_agent';
  const isQuick = location.pathname.startsWith('/s/') || location.pathname === '/suporte' || new URLSearchParams(location.search).has('quick');
  const linkToken = location.pathname.startsWith('/s/') ? decodeURIComponent(location.pathname.slice(3)) : null;

  const PERM_LABEL = { ver: 'Ver a tela', controlar: 'Controlar mouse e teclado', arquivos: 'Transferir arquivos', gravar: 'Gravar a sessão', clipboard: 'Usar a área de transferência', reiniciar: 'Reiniciar o computador' };
  const PERM_ORDER = ['ver', 'controlar', 'arquivos', 'gravar', 'clipboard', 'reiniciar'];
  const PERM_DEFAULT = { ver: true, controlar: true, arquivos: true, clipboard: true, gravar: false, reiniciar: false };

  let creds = null;          // { deviceId, agentKey, company, name, accessMode }
  let ws = null;
  let state = { password: '', online: false, company: null, name: '', accessMode: 'permissao' };
  let stream = null;         // MediaStream da tela
  let keepForUnattended = false;
  let sess = null;           // sessão ativa
  let reqModal = null;
  let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  api('/api/config').then((c) => { iceServers = c.iceServers; }).catch(() => {});

  const loadCreds = () => { try { return JSON.parse((isQuick ? sessionStorage : localStorage).getItem(STORE)); } catch { return null; } };
  const saveCreds = (c) => { try { (isQuick ? sessionStorage : localStorage).setItem(STORE, JSON.stringify(c)); } catch {} };
  const clearCreds = () => { try { (isQuick ? sessionStorage : localStorage).removeItem(STORE); } catch {} };

  // ======================= INSTALADOR =======================
  const wz = { step: 1, terms: false, code: new URLSearchParams(location.search).get('empresa') || '', company: null, name: '', mode: 'permissao', pass: '', tasks: [] };
  const STEPS = ['Boas-vindas', 'Empresa', 'Tipo de acesso', 'Instalação', 'Pronto'];

  async function lookup() {
    if (!wz.code) { wz.company = null; return; }
    try { wz.company = await api(`/api/companies/lookup?code=${encodeURIComponent(wz.code)}`); wz.companyErr = null; }
    catch (e) { wz.company = null; wz.companyErr = e.message; }
  }

  function renderWizard() {
    const steps = STEPS.map((s, i) => `<div class="step ${i + 1 === wz.step ? 'on' : i + 1 < wz.step ? 'done' : ''}"><i>${i + 1 < wz.step ? '✓' : i + 1}</i><span>${s}</span></div>`).join('');
    let body = '', nav = '';
    if (wz.step === 1) {
      body = `<div class="eyebrow">Bem-vindo</div><h1>Instalar o Domma View neste computador</h1>
        <p class="muted">Depois de instalado, este computador pode pedir suporte e receber acesso remoto da equipe da sua empresa. O agente fica ativo enquanto esta janela estiver aberta.</p>
        ${wz.company ? `<div class="note">Você abriu o link da empresa <b>${esc(wz.company.name)}</b>. O código de vínculo já veio preenchido.</div>` : ''}
        <label class="check" style="margin-top:18px"><input type="checkbox" id="terms" ${wz.terms ? 'checked' : ''}> Li e aceito os <a href="/termos.html" target="_blank">termos de uso</a> e a <a href="/privacidade.html" target="_blank">política de privacidade</a></label>`;
      nav = `<span></span><button class="btn primary" id="next" ${wz.terms ? '' : 'disabled'}>Continuar</button>`;
    } else if (wz.step === 2) {
      body = `<div class="eyebrow">Vincular à empresa</div><h1>De qual empresa é este computador?</h1>
        <label class="field"><span>Código da empresa</span><input id="code" class="mono" value="${esc(wz.code)}" placeholder="ML-4821-ECV" autocomplete="off"></label>
        <div id="code-st">${wz.company ? `<div class="ok-txt">Encontrado: ${esc(wz.company.grp)} · ${esc(wz.company.name)}</div>` : wz.companyErr ? `<div class="err-txt">${esc(wz.companyErr)}</div>` : ''}</div>
        <label class="field" style="margin-top:14px"><span>Nome deste computador</span><input id="pcname" value="${esc(wz.name)}" placeholder="Recepção" maxlength="60"></label>
        <div class="muted small">É assim que ele vai aparecer na lista de máquinas do Gestor.</div>`;
      nav = `<button class="btn" id="back">Voltar</button><button class="btn primary" id="next" ${wz.company && wz.name.trim() ? '' : 'disabled'}>Continuar</button>`;
    } else if (wz.step === 3) {
      body = `<div class="eyebrow">Tipo de acesso</div><h1>Como o suporte vai entrar?</h1>
        <label class="opt ${wz.mode === 'permissao' ? 'on' : ''}"><input type="radio" name="mode" value="permissao"><b>Com permissão (recomendado)</b><div class="muted small">Cada conexão aparece na tela e quem está no computador precisa aceitar.</div></label>
        <label class="opt ${wz.mode === 'nao_assistido' ? 'on' : ''}"><input type="radio" name="mode" value="nao_assistido"><b>Acesso não assistido</b><div class="muted small">O Gestor da empresa entra sem ninguém aceitar, por exemplo fora do horário. Um aviso fica visível durante o acesso.</div></label>
        ${wz.mode === 'nao_assistido' ? `<label class="field"><span>Senha fixa deste computador (mín. 8 caracteres)</span><input id="upass" type="password" value="${esc(wz.pass)}" autocomplete="new-password"></label>` : ''}
        <div class="muted small">O Gestor ou o Administrador pode mudar isso depois pelo console.</div>`;
      nav = `<button class="btn" id="back">Voltar</button><button class="btn primary" id="next" ${wz.mode === 'nao_assistido' && wz.pass.length < 8 ? 'disabled' : ''}>Instalar</button>`;
    } else if (wz.step === 4) {
      const pct = Math.round((wz.tasks.filter((t) => t.s === 'done').length / Math.max(1, wz.tasks.length)) * 100);
      body = `<div class="eyebrow">Instalando</div><h1>Quase lá</h1><div class="progress"><i style="width:${pct}%"></i></div>
        ${wz.tasks.map((t) => `<div class="task ${t.s}">${t.s === 'done' ? 'Concluído' : t.s === 'doing' ? 'Em andamento' : t.s === 'err' ? 'Erro' : 'A seguir'} · ${esc(t.label)}</div>`).join('')}
        ${wz.err ? `<div class="note danger" style="margin-top:14px">${esc(wz.err)}</div>` : ''}`;
      nav = `<button class="btn" id="back" ${wz.err ? '' : 'disabled'}>Voltar</button><button class="btn primary" id="next" ${pct === 100 ? '' : 'disabled'}>Concluir</button>`;
    } else {
      body = `<div class="eyebrow" style="color:var(--green)">Pronto</div><h1>Este computador já pode receber suporte</h1>
        <div class="muted small">ID deste computador</div><div class="big-id">${fmtId(creds.deviceId)}</div>
        <div class="grid2" style="margin:16px 0"><div class="note"><span class="muted small">Empresa</span><br><b>${esc(creds.company.name)}</b></div>
        <div class="note"><span class="muted small">Acesso</span><br><b>${creds.accessMode === 'nao_assistido' ? 'Não assistido' : 'Com permissão'}</b></div></div>
        <button class="btn primary block" id="ask">Pedir suporte agora</button>`;
      nav = `<span></span><button class="btn" id="next">Abrir o Domma View</button>`;
    }
    root.innerHTML = `<div class="wizard"><aside class="wz-side"><div class="brand">${logo()} Domma View</div><div class="steps">${steps}</div>
      <div class="wz-foot">Agente web 1.0.0 · Chrome, Edge e Firefox · conexão cifrada ponta a ponta</div></aside>
      <section class="wz-main">${body}<div class="wz-nav">${nav}</div></section></div>`;
    bindWizard();
  }

  function bindWizard() {
    const next = $('#next'), back = $('#back');
    back && back.addEventListener('click', () => { wz.step--; wz.err = null; renderWizard(); });
    if (wz.step === 1) {
      $('#terms').addEventListener('change', (e) => { wz.terms = e.target.checked; renderWizard(); });
      next.addEventListener('click', () => { wz.step = 2; renderWizard(); });
    }
    if (wz.step === 2) {
      let t;
      $('#code').addEventListener('input', (e) => {
        wz.code = e.target.value.toUpperCase(); e.target.value = wz.code;
        clearTimeout(t); t = setTimeout(async () => { await lookup(); renderWizard(); $('#code').focus(); $('#code').setSelectionRange(99, 99); }, 450);
      });
      $('#pcname').addEventListener('input', (e) => { wz.name = e.target.value; next.disabled = !(wz.company && wz.name.trim()); });
      next.addEventListener('click', () => { wz.step = 3; renderWizard(); });
    }
    if (wz.step === 3) {
      $$('input[name=mode]').forEach((r) => r.addEventListener('change', () => { wz.mode = r.value; renderWizard(); }));
      const up = $('#upass');
      up && up.addEventListener('input', (e) => { wz.pass = e.target.value; next.disabled = wz.pass.length < 8; });
      next.addEventListener('click', install);
    }
    if (wz.step === 4) next.addEventListener('click', () => { wz.step = 5; renderWizard(); });
    if (wz.step === 5) {
      next.addEventListener('click', startAgent);
      $('#ask').addEventListener('click', () => { startAgent(); setTimeout(askSupport, 300); });
    }
  }

  async function install() {
    wz.step = 4; wz.err = null;
    wz.tasks = [{ label: 'Verificando o navegador', s: 'doing' }, { label: 'Gerando chave do dispositivo', s: 'todo' },
      { label: `Registrando o computador em ${wz.company.name}`, s: 'todo' }, { label: 'Conectando ao servidor de sinalização', s: 'todo' }];
    renderWizard();
    const step = async (i, fn) => { wz.tasks[i].s = 'doing'; renderWizard(); await fn(); wz.tasks[i].s = 'done'; await new Promise((r) => setTimeout(r, 250)); renderWizard(); };
    try {
      await step(0, async () => { if (!navigator.mediaDevices?.getDisplayMedia || !window.RTCPeerConnection) throw new Error('Este navegador não suporta compartilhamento de tela. Use Chrome, Edge ou Firefox no computador.'); });
      const info = await sysinfo();
      await step(1, async () => {});
      await step(2, async () => {
        const r = await api('/api/agent/register', { body: { companyCode: wz.code, name: wz.name.trim(), os: info.os, accessMode: wz.mode, unattendedPassword: wz.pass, termsAccepted: true } });
        creds = { deviceId: r.deviceId, agentKey: r.agentKey, company: r.company, name: r.name, accessMode: r.accessMode };
        saveCreds(creds);
      });
      await step(3, async () => {});
    } catch (e) {
      const i = wz.tasks.findIndex((t) => t.s === 'doing'); if (i >= 0) wz.tasks[i].s = 'err';
      wz.err = e.message; renderWizard();
    }
  }

  // ======================= QUICKSUPPORT =======================
  async function startQuick() {
    creds = loadCreds();
    let company = null;
    if (linkToken && !creds) {
      try { company = (await api(`/api/support-link/${encodeURIComponent(linkToken)}`)).company; }
      catch (e) { root.innerHTML = `<div class="agent"><div class="agent-card"><div class="agent-head"><div class="brand">${logo()} Domma View QuickSupport</div></div><div class="agent-body"><div class="note danger">${esc(e.message)}</div></div></div></div>`; return; }
      root.innerHTML = `<div class="agent"><div class="agent-card"><div class="agent-head"><div class="brand">${logo()} Domma View QuickSupport</div>${orgBox(company)}</div>
        <div class="agent-body"><h2>Do que você precisa?</h2><p class="muted small">Seu pedido cai direto na fila de ${esc(company.name)}. Não precisa instalar nada.</p>
        <label class="field"><span>Seu nome ou do computador</span><input id="qname" maxlength="60" placeholder="Ex.: Recepção da loja"></label>
        <label class="field"><span>Motivo</span><input id="qreason" maxlength="200" placeholder="Ex.: impressora não imprime o laudo"></label>
        <button class="btn primary block" id="qgo">Pedir suporte</button></div></div></div>`;
      $('#qgo').addEventListener('click', async () => {
        const info = await sysinfo();
        try {
          const r = await api('/api/agent/quick', { body: { token: linkToken, name: $('#qname').value || 'QuickSupport', reason: $('#qreason').value || 'Pedido de suporte', os: info.os } });
          creds = { deviceId: r.deviceId, agentKey: r.agentKey, quick: true }; saveCreds(creds); startAgent();
        } catch (e) { toast(e.message, true); }
      });
      return;
    }
    if (!creds) {
      const info = await sysinfo();
      try { const r = await api('/api/agent/quick', { body: { os: info.os } }); creds = { deviceId: r.deviceId, agentKey: r.agentKey, quick: true }; saveCreds(creds); }
      catch (e) { toast(e.message, true); return; }
    }
    startAgent();
  }

  const orgBox = (c) => c ? `<div class="org"><div class="logo-box">${esc(DV.initials(c.name))}</div><div><small>Suporte oferecido por</small><b>${esc(c.name)}</b></div>${c.verified ? '<span class="ver">Verificada</span>' : '<span class="ver" style="color:#f0b45a">Não verificada</span>'}</div>` : '';

  // ======================= AGENTE CONECTADO =======================
  function startAgent() {
    if (ws) return;
    renderAgent();
    ws = socket(onMsg, async (s) => { s.send({ type: 'hello', deviceId: creds.deviceId, agentKey: creds.agentKey, sysinfo: await sysinfo() }); });
    window.addEventListener('beforeunload', (e) => { if (sess) { e.preventDefault(); e.returnValue = ''; } });
  }

  function renderAgent() {
    const c = state.company;
    const quick = isQuick;
    const live = sess && sess.live;
    const draft = $('#chat-in')?.value || '';
    const hadFocus = document.activeElement && document.activeElement.id === 'chat-in';
    queueMicrotask(() => { const i = $('#chat-in'); if (i && draft) i.value = draft; if (i && hadFocus) i.focus(); });
    root.innerHTML = `
      ${live ? `<div class="conn-bar"><span class="live-dot"></span><div><b>${esc(sess.tech.name)} está conectado</b><div class="small" style="color:#a79fd0">${esc(sess.tech.company || '')} · ${sess.unattended ? 'acesso não assistido' : 'você permitiu este acesso'}</div></div><button class="btn danger" id="end">Encerrar</button></div>
        <div class="rec-agent" id="rec-agent" ${sess.recording ? '' : 'hidden'}>● Esta sessão está sendo gravada e vai para a Auditoria da empresa.</div>` : ''}
      <div class="agent"><div class="agent-card">
        <div class="agent-head"><div class="brand">${logo()} Domma View${quick ? ' QuickSupport' : ''}</div>${orgBox(c)}</div>
        <div class="agent-body">
          ${live ? sessionPanel() : `
          <p class="muted small" style="margin-top:0">Informe estes dados ao técnico que está falando com você. Você vai poder aceitar ou recusar antes de qualquer acesso.</p>
          <div class="muted small">Seu ID</div>
          <div class="row"><div class="big-id">${fmtId(creds.deviceId)}</div><button class="icon-btn" id="copy-id" title="Copiar ID">⧉</button></div>
          <div class="muted small" style="margin-top:10px">Senha temporária · muda a cada sessão</div>
          <div class="row"><div class="pw">${esc(state.password || '········')}</div><button class="icon-btn" id="rotate" title="Gerar outra senha">↻</button></div>
          <div class="note warn" style="margin-top:16px">⚠ <b>Atenção a golpes.</b> Nenhum banco, Receita ou operadora pede acesso remoto. Se alguém ligou pedindo isso, feche esta janela.</div>
          ${!quick ? `<hr class="sep"><div class="between"><div><b>${esc(state.name)}</b><div class="muted small">${state.accessMode === 'nao_assistido' ? 'Acesso não assistido ativado' : 'Acesso com permissão'}</div></div><button class="btn primary" id="ask">Pedir suporte agora</button></div>` : ''}
          ${state.accessMode === 'nao_assistido' && !quick ? `<div class="note" style="margin-top:14px"><b>Acesso não assistido.</b> O navegador só libera a tela depois de um clique. ${stream ? 'Tela liberada: o Gestor pode entrar sem aceite enquanto esta janela estiver aberta.' : ''}
            <div style="margin-top:8px">${stream ? '<button class="btn sm" id="un-stop">Parar de liberar a tela</button>' : '<button class="btn sm primary" id="un-start">Liberar a tela para acesso não assistido</button>'}</div></div>` : ''}`}
        </div>
        <div class="agent-foot"><span><span class="dot ${state.online ? '' : 'off'}"></span>${state.online ? (live ? 'Em sessão · cifrada ponta a ponta' : 'Pronto para conectar') : 'Conectando ao servidor…'}</span>
          <span class="muted">${quick ? 'Não precisa instalar' : `<button class="link small" id="uninstall">Desinstalar</button>`}</span></div>
      </div></div>`;
    bindAgent();
  }

  function sessionPanel() {
    const p = sess.perms;
    return `<div class="between"><h2>Atendimento em andamento</h2><span class="badge live">${p.map((x) => PERM_LABEL[x]).length} permissões</span></div>
      <div class="muted small" style="margin-bottom:10px">${p.map((x) => esc(PERM_LABEL[x])).join(' · ')}</div>
      ${sess.monitorAsk ? `<div class="note" style="margin-bottom:10px">O técnico pediu para ver outra tela. <button class="btn sm primary" id="pick">Escolher outra tela</button></div>` : ''}
      <div class="chat-box" id="chat">${sess.chat.map((m) => `<div class="msg ${m.me ? 'me' : ''}"><small>${esc(m.me ? 'Você' : sess.tech.name)}</small>${esc(m.text)}</div>`).join('')}</div>
      <div class="row" style="margin-top:8px"><input id="chat-in" placeholder="Escreva para o técnico" maxlength="2000"><button class="btn primary" id="chat-send">Enviar</button></div>
      ${sess.clip ? `<div class="note" style="margin-top:12px">O técnico enviou um texto para a área de transferência. <button class="btn sm" id="clip-copy">Copiar</button></div>` : ''}
      ${p.includes('arquivos') ? `<hr class="sep"><div class="between"><h3>Arquivos</h3><label class="btn sm">Compartilhar arquivos com o técnico<input type="file" id="share" multiple hidden></label></div>
        <div class="muted small">Só os arquivos que você escolher ficam visíveis para o técnico.</div>
        ${sess.shared.map((f) => `<div class="file-row">📄 ${esc(f.file.name)}<span class="sz">${fmtBytes(f.file.size)}</span></div>`).join('')}
        ${sess.received.length ? `<h3 style="margin-top:12px">Recebidos do técnico</h3>${sess.received.map((f) => `<div class="file-row">⬇ <a href="${f.url}" download="${esc(f.name)}">${esc(f.name)}</a><span class="sz">${fmtBytes(f.size)}</span></div>`).join('')}` : ''}` : ''}
      <hr class="sep"><div class="muted small">Você pode encerrar a qualquer momento pelo botão no topo. Seu navegador também mostra um aviso enquanto a tela é compartilhada.</div>`;
  }

  function bindAgent() {
    const on = (id, fn, ev = 'click') => { const el = $('#' + id); el && el.addEventListener(ev, fn); };
    on('copy-id', () => { navigator.clipboard?.writeText(creds.deviceId); toast('ID copiado'); });
    on('rotate', () => ws.send({ type: 'rotate' }));
    on('ask', askSupport);
    on('un-start', async () => { if (await captureScreen()) { keepForUnattended = true; ws.send({ type: 'agent-state', unattendedReady: true }); renderAgent(); } });
    on('un-stop', () => { keepForUnattended = false; stopStream(); ws.send({ type: 'agent-state', unattendedReady: false }); renderAgent(); });
    on('uninstall', () => {
      if (!confirm('Remover o Domma View deste navegador? O computador deixa de receber acesso.')) return;
      clearCreds(); ws && ws.close(); location.href = location.pathname;
    });
    on('end', () => endLocal(true));
    on('chat-send', sendChat);
    on('chat-in', (e) => { if (e.key === 'Enter') sendChat(); }, 'keydown');
    on('clip-copy', async () => { try { await navigator.clipboard.writeText(sess.clip); toast('Copiado para a área de transferência'); sess.clip = null; renderAgent(); } catch { toast('O navegador bloqueou a cópia.', true); } });
    on('share', (e) => {
      for (const file of e.target.files) sess.shared.push({ id: Math.random().toString(36).slice(2), file });
      sess.ch && sess.ch.send({ t: 'files-list', files: sess.shared.map((f) => ({ id: f.id, name: f.file.name, size: f.file.size })) });
      renderAgent();
    }, 'change');
    on('pick', async () => {
      const old = stream;
      try {
        const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
        const track = s.getVideoTracks()[0];
        const sender = sess.pc.getSenders().find((x) => x.track && x.track.kind === 'video');
        await sender.replaceTrack(track);
        stream = s; watchTrack(track); old && old.getTracks().forEach((t) => t.stop());
        sess.monitorAsk = false; renderAgent();
        ws.send({ type: 'session-event', sid: sess.sid, event: 'monitor_trocado' });
      } catch {}
    });
    const chat = $('#chat'); if (chat) chat.scrollTop = chat.scrollHeight;
  }

  function sendChat() {
    const inp = $('#chat-in'); const text = inp.value.trim();
    if (!text || !sess.ch) return;
    sess.ch.send({ t: 'chat', text }); sess.chat.push({ me: true, text }); inp.value = ''; renderAgent(); $('#chat-in').focus();
  }

  function askSupport() {
    modal(`<div class="mh"><h2>Pedir suporte</h2><div class="muted small">Seu pedido cai na fila da equipe de suporte.</div></div>
      <div class="mb"><label class="field"><span>O que está acontecendo?</span><textarea id="reason" rows="3" maxlength="300" placeholder="Ex.: erro ao anexar fotos da vistoria"></textarea></label></div>
      <div class="mf"><button class="btn" data-close>Cancelar</button><button class="btn primary" id="send-t">Enviar pedido</button></div>`, {
      onMount: (el, close) => $('#send-t', el).addEventListener('click', () => { ws.send({ type: 'ticket', reason: $('#reason', el).value.trim() || 'Pedido de suporte' }); close(); }),
    });
  }

  async function captureScreen() {
    if (stream && stream.active) return true;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 60 }, displaySurface: 'monitor' }, audio: false });
      watchTrack(stream.getVideoTracks()[0]);
      return true;
    } catch { toast('A tela não foi compartilhada.', true); return false; }
  }
  function watchTrack(track) {
    track.addEventListener('ended', () => {
      if (stream && stream.getVideoTracks()[0] !== track) return;
      stream = null; keepForUnattended = false;
      ws && ws.send({ type: 'agent-state', unattendedReady: false });
      if (sess) endLocal(true); else renderAgent();
    });
  }
  function stopStream() { stream && stream.getTracks().forEach((t) => t.stop()); stream = null; }

  // ---------- pedido de acesso (seção 7.4) ----------
  function showRequest(m) {
    reqModal && reqModal.close();
    let left = Math.round(m.timeout / 1000);
    const checks = PERM_ORDER.map((k) => {
      const asked = m.perms.includes(k);
      return `<label class="check" ${asked ? '' : 'style="opacity:.4"'}><input type="checkbox" data-p="${k}" ${asked && PERM_DEFAULT[k] ? 'checked' : ''} ${asked ? '' : 'disabled'} ${k === 'ver' ? 'checked disabled' : ''}> ${PERM_LABEL[k]}</label>`;
    }).join('');
    reqModal = modal(`<div class="mh"><div class="row"><div class="avatar" style="width:44px;height:44px">${esc(m.tech.initials)}</div>
      <div class="grow"><h2>${esc(m.tech.name)} quer acessar este computador</h2><div class="muted small">${m.tech.verified ? 'Técnico verificado' : 'Conta não verificada'} · ${esc(m.tech.company)}</div></div><span class="timer" id="tmr">0:${String(left).padStart(2, '0')}</span></div></div>
      <div class="mb"><b>Confirme o código com o técnico</b><div class="muted small">Ele vê o mesmo código na tela dele. Se for diferente, recuse.</div>
        <div class="req-code">${esc(m.code)}</div>
        <div style="margin-top:14px"><b>O que ele poderá fazer</b><div class="perm-box">${checks}</div></div>
        <div class="note danger" style="margin-top:14px">🛡 <b>Modo anti-golpe ligado.</b> Banco, Receita e operadoras não pedem acesso remoto. Você pode encerrar a qualquer momento pelo botão no topo da janela.</div></div>
      <div class="mf"><button class="btn" id="refuse">Recusar</button><button class="btn primary" id="allow">Permitir acesso</button></div>`, {
      dismissable: false,
      onMount: (el, close) => {
        const timer = setInterval(() => { left--; const t = $('#tmr', el); if (t) t.textContent = `0:${String(Math.max(0, left)).padStart(2, '0')}`; if (left <= 0) { clearInterval(timer); close(); } }, 1000);
        $('#refuse', el).addEventListener('click', () => { clearInterval(timer); ws.send({ type: 'refuse', reqId: m.reqId }); close(); });
        $('#allow', el).addEventListener('click', async () => {
          // getDisplayMedia precisa do clique do usuário: pedimos a tela aqui
          const perms = $$('input[data-p]', el).filter((i) => i.checked).map((i) => i.dataset.p);
          clearInterval(timer); close();
          if (!(await captureScreen())) { ws.send({ type: 'refuse', reqId: m.reqId }); return; }
          ws.send({ type: 'accept', reqId: m.reqId, perms });
        });
        if ('Notification' in window && Notification.permission === 'granted' && document.hidden) new Notification('Domma View', { body: `${m.tech.name} quer acessar este computador` });
      },
    });
    reqModal.reqId = m.reqId;
    document.title = '● Pedido de acesso · Domma View';
  }

  // ---------- WebRTC (agente oferece a mídia) ----------
  async function beginRtc() {
    const pc = new RTCPeerConnection({ iceServers });
    sess.pc = pc;
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));
    const dc = pc.createDataChannel('dv', { ordered: true });
    sess.ch = DVChannel.wrap(dc, {
      onMessage: onData,
      onFile: (f) => {
        const url = URL.createObjectURL(f.blob);
        sess.received.push({ name: f.name, size: f.size, url });
        toast(`Arquivo recebido: ${f.name}`); renderAgent();
      },
    });
    dc.onopen = () => { if (sess.shared.length) sess.ch.send({ t: 'files-list', files: sess.shared.map((f) => ({ id: f.id, name: f.file.name, size: f.file.size })) }); sess.ch.send({ t: 'hello', sysinfo: sess.sysinfo }); };
    pc.onicecandidate = (e) => e.candidate && ws.send({ type: 'signal', sid: sess.sid, data: { candidate: e.candidate } });
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') toast('Falha na conexão com o técnico.', true); };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send({ type: 'signal', sid: sess.sid, data: { sdp: pc.localDescription } });
  }

  function onData(m) {
    if (!sess) return;
    if (m.t === 'chat') { sess.chat.push({ me: false, text: String(m.text).slice(0, 2000) }); renderAgent(); }
    if (m.t === 'clip' && sess.perms.includes('clipboard')) { sess.clip = String(m.text).slice(0, 20000); renderAgent(); }
    if (m.t === 'file-get' && sess.perms.includes('arquivos')) { const f = sess.shared.find((x) => x.id === m.id); if (f) sess.ch.sendFile(f.file, f.id); }
    if (m.t === 'monitor') { sess.monitorAsk = true; renderAgent(); }
    if (m.t === 'quality') applyQuality(m.v);
  }

  async function applyQuality(v) {
    const sender = sess.pc.getSenders().find((x) => x.track && x.track.kind === 'video');
    if (!sender) return;
    const p = sender.getParameters(); if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    const cfg = { max: { fr: 60, scale: 1, br: 8_000_000 }, fast: { fr: 15, scale: 2, br: 600_000 }, auto: { fr: 30, scale: 1, br: undefined } }[v] || {};
    p.encodings[0].scaleResolutionDownBy = cfg.scale; p.encodings[0].maxFramerate = cfg.fr;
    if (cfg.br) p.encodings[0].maxBitrate = cfg.br; else delete p.encodings[0].maxBitrate;
    try { await sender.setParameters(p); await sender.track.applyConstraints({ frameRate: cfg.fr }); } catch {}
  }

  function endLocal(notify) {
    if (!sess) return;
    if (notify) ws.send({ type: 'end', sid: sess.sid });
    try { sess.pc && sess.pc.close(); } catch {}
    sess.received.forEach((f) => setTimeout(() => URL.revokeObjectURL(f.url), 60000));
    sess = null;
    if (!keepForUnattended) stopStream();
    document.title = 'Domma View · Agente';
    renderAgent();
  }

  async function onMsg(m) {
    switch (m.type) {
      case 'welcome':
        state = { ...state, online: true, password: m.password, company: m.company, name: m.name, accessMode: m.accessMode };
        if (keepForUnattended && stream) ws.send({ type: 'agent-state', unattendedReady: true });
        if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
        if (!sess) renderAgent();
        break;
      case 'password': state.password = m.password; if (!sess) renderAgent(); break;
      case 'disconnected': state.online = false; if (sess) endLocal(false); else renderAgent(); break;
      case 'error':
        if (m.code === 'unknown_device') { clearCreds(); ws.close(); ws = null; toast(m.message, true); setTimeout(() => location.reload(), 1500); return; }
        if (m.code === 'replaced') { ws.close(); root.innerHTML = `<div class="agent"><div class="note">${esc(m.message)}</div></div>`; return; }
        toast(m.message, true); break;
      case 'ticket-ok': toast(m.already ? 'Você já tem um pedido na fila. Aguarde o técnico.' : 'Pedido enviado. Aguarde o técnico entrar em contato.'); break;
      case 'request': showRequest(m); break;
      case 'cancel': if (reqModal && reqModal.reqId === m.reqId) { reqModal.close(); toast('O técnico cancelou o pedido.'); document.title = 'Domma View · Agente'; } break;
      case 'session':
        if (!stream && !(await captureScreen())) { ws.send({ type: 'end', sid: m.sid }); return; }
        sess = { sid: m.sid, tech: m.tech, perms: m.perms, unattended: m.unattended, live: true, chat: [], shared: [], received: [], recording: false, sysinfo: await sysinfo() };
        document.title = `● ${m.tech.name} conectado · Domma View`;
        renderAgent();
        await beginRtc();
        break;
      case 'signal':
        if (!sess || sess.sid !== m.sid) return;
        if (m.data.sdp) await sess.pc.setRemoteDescription(m.data.sdp);
        else if (m.data.candidate) { try { await sess.pc.addIceCandidate(m.data.candidate); } catch {} }
        break;
      case 'recording': if (sess && sess.sid === m.sid) { sess.recording = m.on; renderAgent(); } break;
      case 'end': if (sess && sess.sid === m.sid) { endLocal(false); toast('A sessão foi encerrada.'); } break;
    }
  }

  // ======================= início =======================
  if (isQuick) startQuick();
  else {
    creds = loadCreds();
    if (creds) startAgent();
    else lookup().then(renderWizard);
  }
})();
