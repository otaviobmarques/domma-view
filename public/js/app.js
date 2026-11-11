// Console web + app do técnico (seções 7.1, 7.8–7.12).
(() => {
  const { esc, $, $$, api, toast, modal, logo, fmtId, fmtBytes, fmtDur, fmtWhen, initials, socket } = DV;
  const root = $('#root');
  let me = null, tech = null, iceServers = [], pendingModal = null, queueCount = 0, wsOnline = false;
  const ROLE = { admin: 'Administrador', gestor: 'Gestor', funcionario: 'Funcionário' };
  const STATUS = { online: ['Online', 'on'], offline: ['Offline', 'off'], em_sessao: ['Em sessão', 'live'] };

  // ===================== boot =====================
  async function boot() {
    try { me = await api('/api/me'); } catch (e) { if (e.status === 401) return renderLogin(); throw e; }
    try { iceServers = (await api('/api/config')).iceServers; } catch {}
    if (me.user.role !== 'funcionario') tech = socket(onTechMsg, () => { wsOnline = true; updateStatusChip(); });
    window.addEventListener('hashchange', route);
    DVSession.onEnd = () => { refreshMe(); route(); };
    setInterval(refreshMe, 15000);
    route();
  }
  async function refreshMe() {
    try { me = await api('/api/me'); renderPlanBox(); if (me.perms.fila) { queueCount = (await api('/api/tickets')).filter((t) => t.status === 'aberto').length; renderNavCount(); } } catch {}
  }

  function renderLogin(err) {
    root.innerHTML = `<div class="login-wrap"><div class="login">
      <div class="row" style="margin-bottom:18px">${logo(34)}<div><b style="font-size:20px">Domma View</b><div class="eyebrow" style="font-size:9px">Acesso remoto</div></div></div>
      <div class="card"><h2>Entrar no console</h2><p class="muted small">Use o e-mail e a senha que o Administrador da conta criou para você.</p>
      <form id="lf"><label class="field"><span>E-mail</span><input name="email" type="email" autocomplete="username" required></label>
      <label class="field"><span>Senha</span><input name="password" type="password" autocomplete="current-password" required></label>
      ${err ? `<div class="note danger" style="margin-bottom:12px">${esc(err)}</div>` : ''}
      <button class="btn primary block">Entrar</button></form></div>
      <p class="muted small" style="text-align:center;margin-top:18px">Precisa de ajuda agora? <a href="/suporte">Abrir o QuickSupport</a> · <a href="/agente.html">Instalar o agente</a></p>
    </div></div>`;
    $('#lf').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try { await api('/api/login', { body: { email: f.get('email'), password: f.get('password') } }); location.hash = '#/inicio'; boot(); }
      catch (er) { renderLogin(er.message); }
    });
  }

  // ===================== layout =====================
  const NAV = [
    ['inicio', 'Início', () => true],
    ['dispositivos', 'Meus dispositivos', () => me.perms.gerir],
    ['fila', 'Fila de suporte', () => me.perms.fila],
    ['equipe', 'Equipe e permissões', () => me.perms.convidar],
    ['auditoria', 'Auditoria e gravações', () => me.perms.historico],
    ['planos', 'Planos e licença', () => me.perms.cobranca],
    ['conta', 'Minha conta', () => true],
  ];
  function layout(active, html) {
    const nav = NAV.filter(([, , ok]) => ok()).map(([k, l]) => `<a href="#/${k}" class="${k === active ? 'on' : ''}">${l}${k === 'fila' ? '<span id="qcount"></span>' : ''}</a>`).join('');
    root.innerHTML = `<div class="app"><aside class="side"><div class="brand">${logo()}<div>Domma View<small>ACESSO REMOTO</small></div></div>
      <nav class="nav">${nav}</nav>
      <div class="plan" id="planbox"></div>
      <div class="me"><b style="color:#fff">${esc(me.user.name)}</b><br>${ROLE[me.user.role]} · ${esc(me.user.company_name || '')}<br><button class="link small" id="logout" style="color:#a593f5">Sair</button></div>
      </aside><main id="main">${me.user.must_change ? `<div class="note warn" style="margin-bottom:16px">Você está usando uma senha provisória. <a href="#/conta">Troque agora</a>.</div>` : ''}${html}</main></div>`;
    $('#logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); tech && tech.close(); location.hash = ''; location.reload(); });
    renderPlanBox(); renderNavCount();
  }
  function renderPlanBox() {
    const b = $('#planbox'); if (!b || !me.planInfo) return;
    const used = me.live.activeSessions, lim = me.live.limit;
    b.innerHTML = `<b style="color:#fff">Plano ${esc(me.planInfo.name)}</b><div style="margin-top:4px">${used} de ${lim} sessões simultâneas em uso</div><div class="bar"><i style="width:${Math.min(100, (100 * used) / lim)}%"></i></div>`;
  }
  function renderNavCount() { const c = $('#qcount'); if (c) c.innerHTML = queueCount ? `<span class="pill-count">${queueCount}</span>` : ''; }
  function updateStatusChip() {
    const c = $('#srv-chip'); if (!c) return;
    c.innerHTML = wsOnline ? '🛡 Pronto · conexão criptografada ponta a ponta' : 'Conectando ao servidor…';
    c.style.background = wsOnline ? '' : 'var(--amber-50)'; c.style.color = wsOnline ? '' : 'var(--amber)';
  }

  async function route() {
    if (!me) return;
    if (!pendingModal) document.querySelectorAll('.overlay').forEach((o) => o.remove());
    const page = (location.hash.replace(/^#\//, '') || 'inicio').split('?')[0];
    const item = NAV.find(([k]) => k === page);
    if (!item || !item[2]()) { location.hash = '#/inicio'; return; }
    try { await PAGES[page](); } catch (e) { console.error(e); toast(e.message, true); }
  }

  // ===================== técnico: conectar =====================
  function connectTo(deviceId, opts = {}) {
    if (!tech || !tech.open) return toast('Sem conexão com o servidor. Tente de novo em instantes.', true);
    if (DVSession.active) return toast('Encerre a sessão atual antes de abrir outra.', true);
    const myAgent = readLocalAgent();
    tech.send({ type: 'connect', deviceId: String(deviceId).replace(/\D/g, ''), password: opts.password || '', mode: opts.mode || 'controle', ticketId: opts.ticketId || null, fromId: myAgent ? myAgent.deviceId : null });
    connectTo.openFiles = opts.mode === 'arquivos';
  }
  function readLocalAgent() { try { return JSON.parse(localStorage.getItem('dv_agent')); } catch { return null; } }

  function onTechMsg(m) {
    switch (m.type) {
      case 'disconnected': wsOnline = false; updateStatusChip(); if (DVSession.active) DVSession.end(false); break;
      case 'pending': {
        pendingModal && pendingModal.close();
        if (m.unattended) { toast('Acesso não assistido · entrando…'); break; }
        let left = Math.round(m.timeout / 1000);
        pendingModal = modal(`<div class="mh"><h2>Aguardando ${esc(m.device.name)} aceitar</h2><div class="muted small">ID ${fmtId(m.device.id)}</div></div>
          <div class="mb"><b>Código de confirmação</b><div class="muted small">Peça para a pessoa conferir este código na tela dela antes de aceitar.</div>
          <div class="mono" style="font-size:38px;color:var(--violet);letter-spacing:.1em;margin:10px 0">${esc(m.code)}</div>
          <div class="muted small">Expira em <b id="pl">${left}</b> s</div></div>
          <div class="mf"><button class="btn" id="pc">Cancelar pedido</button></div>`, {
          dismissable: false,
          onMount: (el, close) => {
            const t = setInterval(() => { left--; const x = $('#pl', el); if (x) x.textContent = Math.max(0, left); if (left <= 0) clearInterval(t); }, 1000);
            $('#pc', el).addEventListener('click', () => { clearInterval(t); tech.send({ type: 'cancel', reqId: m.reqId }); close(); });
          },
        });
        break;
      }
      case 'refused': case 'error':
        pendingModal && pendingModal.close(); pendingModal = null; toast(m.message, true); break;
      case 'session':
        pendingModal && pendingModal.close(); pendingModal = null;
        DVSession.open(m, tech, iceServers, { openFiles: connectTo.openFiles });
        connectTo.openFiles = false;
        break;
      case 'signal': DVSession.onSignal(m); break;
      case 'svc-frame': case 'svc-desktop': case 'priv-result': DVSession.onService(m); break;
      case 'end': if (DVSession.active && DVSession.active.sid === m.sid) DVSession.end(false, m.by); break;
      case 'queue-changed': refreshMe(); if (location.hash.startsWith('#/fila')) PAGES.fila(); break;
    }
  }

  // ===================== páginas =====================
  const PAGES = {};
  const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite'; };

  // ---------- 7.1 Início ----------
  PAGES.inicio = async () => {
    const agent = readLocalAgent();
    const canConnect = me.perms.acessar;
    const first = esc(me.user.name.split(' ')[0]);
    layout('inicio', `<div class="eyebrow">${greeting()}, ${first}</div><h1 style="margin-bottom:8px">Conecte-se a qualquer computador</h1>
      <span class="status-chip" id="srv-chip" style="margin-bottom:20px">…</span>
      <div class="grid2" style="margin-top:18px">
        <div class="card"><h2>Permitir acesso a este computador</h2><p class="muted small">Passe o ID e a senha só para quem você conhece.</p>
          ${agent ? `<div class="muted small">Seu ID</div><div class="big-id">${fmtId(agent.deviceId)}</div>
            <p class="small muted">${esc(agent.name || 'Este computador')} · ${esc(agent.company?.name || '')}. A senha temporária aparece na janela do agente.</p>
            <a class="btn primary" href="/agente.html" target="dv-agent">Abrir o agente</a>
            ${me.user.role === 'funcionario' && me.user.device_id !== agent.deviceId ? '<button class="btn" id="link-dev" style="margin-left:8px">Vincular à minha conta</button>' : ''}`
          : `<p>Este computador ainda não tem o Domma View. Instale o agente para receber suporte e aparecer na lista do Gestor.</p>
            <a class="btn primary" href="/agente.html${me.user.company_id ? '' : ''}" target="dv-agent">Instalar o agente neste computador</a>
            <p class="small muted" style="margin-top:10px">Atendimento avulso, sem instalar: <a href="/suporte" target="_blank">QuickSupport</a>.</p>`}
        </div>
        <div class="card"><h2>Controlar um computador remoto</h2><p class="muted small">${canConnect ? 'Digite o ID do parceiro ou escolha um dispositivo salvo.' : 'O perfil Funcionário não acessa outras máquinas.'}</p>
          ${canConnect ? `<label class="field"><span>ID do parceiro</span><input id="pid" class="mono" style="font-size:18px" placeholder="000 000 000" inputmode="numeric" autocomplete="off"></label>
          <label class="field"><span>Senha (só para computadores fora da sua empresa)</span><input id="ppw" class="mono" placeholder="xxxx-xxxx" autocomplete="off"></label>
          <div class="chips" id="modes"><button class="chip on" data-m="controle">Controle remoto</button><button class="chip" data-m="arquivos">Transferir arquivos</button><button class="chip" data-m="visualizar">Só visualizar</button></div>
          <button class="btn primary block" id="go">Conectar →</button>
          <p class="small" style="text-align:center"><button class="link" id="what">Ver o que o cliente vê ao receber o pedido</button></p>` : ''}
        </div>
      </div>
      ${canConnect ? `<div class="between" style="margin:26px 0 10px"><h2>Recentes</h2>${me.perms.gerir ? '<a href="#/dispositivos" class="small">Ver todos os dispositivos</a>' : ''}</div><div class="card" style="padding:6px 8px" id="recent"><div class="muted small" style="padding:12px">Carregando…</div></div>` : ''}`);
    updateStatusChip();
    if (me.user.role === 'funcionario') { const c = $('#srv-chip'); c.textContent = '🛡 Conexões sempre cifradas ponta a ponta'; }
    const ld = $('#link-dev');
    ld && ld.addEventListener('click', async () => { try { await api('/api/me/device', { body: { deviceId: agent.deviceId, agentKey: agent.agentKey } }); toast('Computador vinculado à sua conta.'); me = await api('/api/me'); PAGES.inicio(); } catch (e) { toast(e.message, true); } });
    if (!canConnect) return;
    let mode = 'controle';
    $$('#modes .chip').forEach((b) => b.addEventListener('click', () => { $$('#modes .chip').forEach((x) => x.classList.remove('on')); b.classList.add('on'); mode = b.dataset.m; }));
    $('#pid').addEventListener('input', (e) => { const d = e.target.value.replace(/\D/g, '').slice(0, 9); e.target.value = d.replace(/(\d{3})(?=\d)/g, '$1 '); });
    const go = () => { const id = $('#pid').value.replace(/\D/g, ''); if (id.length !== 9) return toast('O ID tem 9 dígitos.', true); connectTo(id, { password: $('#ppw').value.trim(), mode }); };
    $('#go').addEventListener('click', go);
    $('#ppw').addEventListener('keydown', (e) => e.key === 'Enter' && go());
    $('#what').addEventListener('click', previewRequest);
    const rec = await api('/api/devices/recent');
    $('#recent').innerHTML = rec.length ? deviceTable(rec, { recent: true }) : '<div class="muted small" style="padding:14px">Seus últimos acessos aparecem aqui.</div>';
    bindDeviceActions($('#recent'));
  };

  function previewRequest() {
    modal(`<div class="mh"><div class="row"><div class="avatar" style="width:44px;height:44px">${esc(initials(me.user.name))}</div><div class="grow"><h2>${esc(me.user.name)} quer acessar este computador</h2>
      <div class="muted small">Técnico verificado · ${esc(me.user.company_name || '')}</div></div><span class="badge warn mono">0:30</span></div></div>
      <div class="mb"><b>Confirme o código com o técnico</b><div class="mono" style="font-size:34px;color:var(--violet)">47 · 19</div>
      <p class="small muted">A pessoa escolhe o que você poderá fazer (ver a tela, controlar, arquivos, gravar, área de transferência, reiniciar), vê o aviso anti-golpe e decide se aceita. Se não responder em 30 s, o pedido expira.</p></div>
      <div class="mf"><button class="btn primary" data-close>Entendi</button></div>`);
  }

  function deviceTable(list, { recent = false } = {}) {
    return `<div class="table-wrap"><table class="t"><thead><tr><th>Dispositivo</th><th>Grupo</th>${recent ? '' : '<th>Sistema</th>'}<th>Status</th>${recent ? '<th>Último acesso</th>' : '<th>Não assistido</th><th>Alertas</th>'}<th></th></tr></thead><tbody>
      ${list.map((d) => `<tr><td><b>${esc(d.name)}</b>${d.quick ? ' <span class="badge">QuickSupport</span>' : ''}<div class="mono small muted">${fmtId(d.id)}</div></td><td class="muted">${esc(d.grp || d.company || '—')}</td>
        ${recent ? '' : `<td>${esc(d.os || '—')}</td>`}<td><span class="badge ${STATUS[d.status][1]}">${STATUS[d.status][0]}</span></td>
        ${recent ? `<td>${fmtWhen(d.last_access)}</td>` : `<td>${d.access_mode === 'nao_assistido' ? 'Sim' : 'Não'}</td><td class="alert-txt">${esc(d.alerts.join(' · '))}</td>`}
        <td style="text-align:right;white-space:nowrap"><button class="link small" data-conn="${d.id}" ${d.status === 'online' ? '' : 'disabled style="opacity:.4"'}>Conectar</button> · <button class="link small" data-files="${d.id}" ${d.status === 'online' ? '' : 'disabled style="opacity:.4"'}>Arquivos</button>${recent ? '' : ` · <button class="link small" data-edit="${d.id}">Editar</button>`}</td></tr>`).join('')}
      </tbody></table></div>`;
  }
  function bindDeviceActions(scope, list) {
    $$('[data-conn]', scope).forEach((b) => b.addEventListener('click', () => connectTo(b.dataset.conn)));
    $$('[data-files]', scope).forEach((b) => b.addEventListener('click', () => connectTo(b.dataset.files, { mode: 'arquivos' })));
    $$('[data-edit]', scope).forEach((b) => b.addEventListener('click', () => editDevice(list.find((d) => d.id === b.dataset.edit))));
  }

  // ---------- 7.8 Dispositivos ----------
  let devFilter = 'Todos';
  PAGES.dispositivos = async () => {
    const [list, companies] = await Promise.all([api('/api/devices'), api('/api/companies')]);
    const groups = ['Todos', ...new Set(list.map((d) => d.grp).filter(Boolean))];
    if (!groups.includes(devFilter)) devFilter = 'Todos';
    const shown = devFilter === 'Todos' ? list : list.filter((d) => d.grp === devFilter);
    const kp = { total: list.length, online: list.filter((d) => d.status !== 'offline').length, live: list.filter((d) => d.status === 'em_sessao').length, alerts: list.filter((d) => d.alerts.length).length };
    layout('dispositivos', `<div class="head"><div><div class="eyebrow">Conta ${esc(me.user.role === 'admin' ? 'Domma View' : me.user.company_name)}</div><h1>Dispositivos</h1></div>
      <div class="actions">${me.user.role === 'admin' ? '<button class="btn" id="unit">Nova unidade</button>' : ''}<button class="btn" id="exp">Exportar lista</button><button class="btn primary" id="inst">Baixar instalador</button></div></div>
      <div class="kpis"><div class="card kpi"><b>${kp.total}</b><span class="muted small">dispositivos</span></div><div class="card kpi"><b style="color:var(--green)">${kp.online}</b><span class="muted small">online agora</span></div>
      <div class="card kpi"><b style="color:var(--violet)">${kp.live}</b><span class="muted small">sessões ativas</span></div><div class="card kpi"><b style="color:var(--amber)">${kp.alerts}</b><span class="muted small">alertas</span></div></div>
      <div class="chips">${groups.map((g) => `<button class="chip ${g === devFilter ? 'on' : ''}" data-g="${esc(g)}">${esc(g)}</button>`).join('')}</div>
      <div class="card" style="padding:6px 8px">${shown.length ? deviceTable(shown) : `<div style="padding:30px;text-align:center"><b>Nenhum computador ainda.</b><p class="muted">Clique em <b>Baixar instalador</b> e abra o link no computador da loja.</p></div>`}</div>`);
    $$('[data-g]').forEach((b) => b.addEventListener('click', () => { devFilter = b.dataset.g; PAGES.dispositivos(); }));
    bindDeviceActions($('#main'), list);
    $('#exp').addEventListener('click', () => {
      const rows = [['Dispositivo', 'ID', 'Grupo', 'Empresa', 'Sistema', 'Status', 'Não assistido', 'Último contato', 'Alertas']]
        .concat(shown.map((d) => [d.name, d.id, d.grp, d.company, d.os, STATUS[d.status][0], d.access_mode === 'nao_assistido' ? 'Sim' : 'Não', d.last_seen ? new Date(d.last_seen).toLocaleString('pt-BR') : '', d.alerts.join(' / ')]));
      const csv = '﻿' + rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"`).join(';')).join('\n');
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = 'dispositivos-domma-view.csv'; a.click();
    });
    $('#inst').addEventListener('click', () => installerModal(companies));
    $('#unit') && $('#unit').addEventListener('click', () => unitModal(companies));
  };

  function unitModal(companies) {
    const groups = [...new Set(companies.map((c) => c.grp).filter(Boolean))];
    modal(`<div class="mh"><h2>Nova unidade</h2><div class="muted small">Cada unidade (loja, matriz, franquia) ganha o próprio código de vínculo e os próprios Gestores.</div></div>
      <div class="mb"><label class="field"><span>Nome da unidade</span><input id="un" maxlength="80" placeholder="ECV Contagem"></label>
      <label class="field"><span>Grupo</span><input id="ug" maxlength="80" list="ugl" placeholder="Franquias MG"><datalist id="ugl">${groups.map((g) => `<option value="${esc(g)}">`).join('')}</datalist></label>
      <label class="field"><span>CNPJ da unidade (opcional)</span><input id="uc" inputmode="numeric" maxlength="18"></label></div>
      <div class="mf"><button class="btn" data-close>Cancelar</button><button class="btn primary" id="us">Criar unidade</button></div>`, {
      onMount: (el, close) => $('#us', el).addEventListener('click', async () => {
        try {
          const r = await api('/api/companies', { body: { name: $('#un', el).value, grp: $('#ug', el).value, cnpj: $('#uc', el).value } });
          close(); toast(`Unidade criada · código ${r.code}`); PAGES.dispositivos();
        } catch (e) { toast(e.message, true); }
      }),
    });
  }

  function installerModal(companies) {
    const opts = companies.map((c) => `<option value="${esc(c.code)}" ${c.id === me.user.company_id ? 'selected' : ''}>${esc(c.grp)} · ${esc(c.name)} (${esc(c.code)})</option>`).join('');
    modal(`<div class="mh"><h2>Baixar instalador</h2><div class="muted small">O link já carrega o código da empresa: o computador entra direto na lista certa.</div></div>
      <div class="mb"><label class="field"><span>Empresa</span><select id="ic">${opts}</select></label>
      <label class="field"><span>Link do instalador</span><div class="row"><input id="il" readonly class="mono small"><button class="btn" id="icp">Copiar</button></div></label>
      <div class="note small">Abra o link no computador da loja e baixe o instalador para Windows: ele já leva o código da empresa e o computador entra direto nesta lista.
      <br><br>Instalação em massa (GPO): <span class="mono">DommaView-Setup.exe /S /EMPRESA=<span id="icx"></span></span></div></div>
      <div class="mf"><button class="btn" data-close>Fechar</button><a class="btn primary" id="io" target="_blank">Abrir instalador</a></div>`, {
      onMount: (el) => {
        const upd = () => { const url = `${location.origin}/download?empresa=${encodeURIComponent($('#ic', el).value)}`; $('#il', el).value = url; $('#io', el).href = url; $('#icx', el).textContent = $('#ic', el).value; };
        $('#ic', el).addEventListener('change', upd); upd();
        $('#icp', el).addEventListener('click', () => { navigator.clipboard.writeText($('#il', el).value); toast('Link copiado'); });
      },
    });
  }

  async function editDevice(d) {
    const companies = me.user.role === 'admin' ? await api('/api/companies') : [];
    modal(`<div class="mh"><h2>${esc(d.name)}</h2><div class="mono small muted">${fmtId(d.id)}</div></div>
      <div class="mb"><label class="field"><span>Nome</span><input id="dn" value="${esc(d.name)}" maxlength="60"></label>
      ${companies.length ? `<label class="field"><span>Empresa / grupo</span><select id="dc">${companies.map((c) => `<option value="${c.id}" ${c.id === d.company_id ? 'selected' : ''}>${esc(c.grp)} · ${esc(c.name)}</option>`).join('')}</select></label>` : ''}
      <label class="field"><span>Tipo de acesso</span><select id="dm"><option value="permissao">Com permissão (cada conexão precisa ser aceita)</option><option value="nao_assistido" ${d.access_mode === 'nao_assistido' ? 'selected' : ''}>Não assistido (Gestor entra sem aceite, com aviso visível)</option></select></label>
      <label class="field" id="dpw-f"><span>Nova senha fixa (opcional, mín. 8)</span><input id="dpw" type="password" autocomplete="new-password"></label>
      <div class="note small">No agente web, o acesso não assistido só funciona depois que alguém clica em “Liberar a tela” na janela do agente: o navegador exige esse clique.</div></div>
      <div class="mf" style="justify-content:space-between"><button class="btn" id="drm" style="color:var(--red)">Remover da conta</button><div class="row"><button class="btn" data-close>Cancelar</button><button class="btn primary" id="ds">Salvar</button></div></div>`, {
      onMount: (el, close) => {
        $('#ds', el).addEventListener('click', async () => {
          try {
            await api(`/api/devices/${d.id}`, { method: 'PATCH', body: { name: $('#dn', el).value, company_id: $('#dc', el)?.value, access_mode: $('#dm', el).value, unattendedPassword: $('#dpw', el).value || undefined } });
            close(); toast('Dispositivo atualizado'); PAGES.dispositivos();
          } catch (e) { toast(e.message, true); }
        });
        $('#drm', el).addEventListener('click', async () => {
          if (!confirm(`Remover ${d.name}? O agente desse computador será desconectado.`)) return;
          try { await api(`/api/devices/${d.id}`, { method: 'DELETE' }); close(); toast('Dispositivo removido'); PAGES.dispositivos(); } catch (e) { toast(e.message, true); }
        });
      },
    });
  }

  // ---------- 7.10 Fila de suporte ----------
  let lastLink = null, queueTimer = null;
  PAGES.fila = async () => {
    const [tickets, team, today, companies] = await Promise.all([api('/api/tickets'), api('/api/team-presence'), api('/api/stats/today'), api('/api/companies')]);
    queueCount = tickets.filter((t) => t.status === 'aberto').length;
    const sla = (t) => { const min = Math.floor((Date.now() - t.created_at) / 60000); return min >= 10 ? ['late', `Atrasado · ${min} min`] : min >= 5 ? ['att', `Atenção · ${min} min`] : ['ok', `No prazo · ${min} min`]; };
    const ORIGIN = { botao: 'Pedir suporte', link: 'Link de suporte', quicksupport: 'QuickSupport' };
    const PRES = { em_sessao: ['Em sessão', 'var(--violet)'], livre: ['Livre', 'var(--green)'], ausente: ['Ausente', 'var(--ink-3)'] };
    layout('fila', `<div class="eyebrow">Atendimento</div><h1>Fila de suporte</h1>
      <div class="grid-side"><div class="stack">${tickets.length ? tickets.map((t) => { const [c, l] = sla(t); return `<div class="card between" style="padding:16px 18px">
        <div class="grow"><b>${esc(t.company || '')} · ${esc(t.device_name || t.requester)}</b> <span class="badge">${ORIGIN[t.origin] || t.origin}</span>
        <div class="muted small">${esc(t.reason)}${t.status === 'em_atendimento' ? ` · em atendimento com ${esc(t.taken_name || '')}` : ''}${t.device_status === 'offline' ? ' · computador offline' : ''}</div></div>
        <span class="badge ${t.status === 'em_atendimento' ? 'live' : c}">${t.status === 'em_atendimento' ? 'Em atendimento' : l}</span>
        ${t.device_status === 'online' ? `<button class="btn primary sm" data-take="${t.id}" data-dev="${t.device_id}">Atender</button>` : `<button class="btn sm" data-close-t="${t.id}">Encerrar</button>`}</div>`; }).join('')
        : '<div class="card" style="text-align:center;padding:36px"><b>Fila vazia</b><p class="muted">Os pedidos do botão “Pedir suporte”, do link de suporte e do QuickSupport aparecem aqui.</p></div>'}</div>
      <div class="stack">
        <div class="card"><h3>Link de suporte</h3><p class="muted small">O cliente abre o link, usa o QuickSupport com a sua marca e cai direto na sua fila. Sem passar ID por telefone.</p>
          ${me.user.role === 'admin' ? `<select id="lc" style="margin-bottom:8px">${companies.map((c) => `<option value="${c.id}" ${c.id === me.user.company_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>` : ''}
          ${lastLink && lastLink.expiresAt > Date.now() ? `<div class="note mono small" style="word-break:break-all">${esc(lastLink.url)}</div>
            <div class="row" style="margin-top:8px"><a class="btn primary sm grow" style="justify-content:center" target="_blank" href="https://wa.me/?text=${encodeURIComponent('Olá! Para eu te ajudar, abra este link de suporte: ' + lastLink.url)}">Enviar pelo WhatsApp</a><button class="btn sm" id="lcp">Copiar</button></div>
            <div class="muted small" style="margin-top:6px">Expira em 30 minutos ou após o primeiro uso.</div>` : ''}
          <button class="btn ${lastLink ? '' : 'primary'} block" id="lnew" style="margin-top:10px">Gerar novo link</button></div>
        <div class="card"><h3>Técnicos agora</h3>${team.map((u) => `<div class="between small" style="padding:5px 0"><span>${esc(u.name)}</span><b style="color:${PRES[u.presence][1]}">${PRES[u.presence][0]}</b></div>`).join('')}</div>
        <div class="note"><div class="eyebrow">Hoje</div>${today.sessions} atendimentos · tempo médio ${today.avgMinutes} min${today.firstContactPct != null ? ` · ${today.firstContactPct}% resolvidos no primeiro contato` : ''}</div>
      </div></div>`);
    $$('[data-take]').forEach((b) => b.addEventListener('click', () => connectTo(b.dataset.dev, { ticketId: Number(b.dataset.take) })));
    $$('[data-close-t]').forEach((b) => b.addEventListener('click', async () => { await api(`/api/tickets/${b.dataset.closeT}/close`, { body: { status: 'cancelado' } }); PAGES.fila(); }));
    $('#lnew').addEventListener('click', async () => { try { lastLink = await api('/api/support-links', { body: { company_id: $('#lc')?.value } }); PAGES.fila(); } catch (e) { toast(e.message, true); } });
    $('#lcp') && $('#lcp').addEventListener('click', () => { navigator.clipboard.writeText(lastLink.url); toast('Link copiado'); });
    renderNavCount();
    clearTimeout(queueTimer); queueTimer = setTimeout(() => { if (location.hash.startsWith('#/fila') && !document.querySelector('.overlay') && !DVSession.active) PAGES.fila(); }, 30000);
  };

  // ---------- 7.9 Equipe e permissões ----------
  let roleTab = 'gestor';
  PAGES.equipe = async () => {
    const [users, matrix, companies] = await Promise.all([api('/api/users'), api('/api/permissions'), api('/api/companies')]);
    const DESC = { admin: 'Acesso total: todas as empresas e máquinas, pessoas, planos, cobrança e auditoria.', gestor: 'Acessa e gerencia as máquinas da própria empresa e a equipe dela.', funcionario: 'Instala o Domma View na própria máquina e pede suporte. Recebe a conexão remota, não acessa outras máquinas.' };
    const val = (v) => v === 'todas' ? ['Todas', 'sim'] : v === 'empresa' ? ['Da sua empresa', ''] : v === 'propria' ? ['Da própria máquina', ''] : v ? ['Sim', 'sim'] : ['Não', 'nao'];
    layout('equipe', `<div class="head"><div><div class="eyebrow">Acessos</div><h1>Equipe e permissões</h1></div><div class="actions"><button class="btn primary" id="inv">Convidar pessoa</button></div></div>
      <div class="grid2" style="grid-template-columns:minmax(0,1fr) minmax(0,1.3fr);align-items:start">
        <div class="card"><h2 style="margin-bottom:8px">Pessoas</h2>${users.map((u) => `<div class="list-item" style="cursor:pointer" data-u="${u.id}"><div class="avatar">${esc(initials(u.name))}</div>
          <div class="grow"><b>${esc(u.name)}</b>${u.active ? '' : ' <span class="badge nao">Inativo</span>'}<div class="muted small">${u.role === 'admin' ? 'Todas as empresas' : u.role === 'funcionario' ? `Própria máquina · ${esc(u.company || '')}` : esc(u.company || '')}</div></div>
          <span class="badge off">${ROLE[u.role]}</span></div>`).join('')}
          <div class="muted small" style="margin-top:10px">Senha com no mínimo 8 caracteres · cada pessoa só vê o que o perfil dela permite.</div></div>
        <div class="card"><div class="between"><h2>Perfis de acesso</h2><div class="chips" style="margin:0">${['admin', 'gestor', 'funcionario'].map((r) => `<button class="chip ${r === roleTab ? 'on' : ''}" data-r="${r}">${ROLE[r]}</button>`).join('')}</div></div>
          <p class="muted small">${DESC[roleTab]}</p>
          <table class="t">${Object.values(matrix).map((p) => { const [l, c] = val(p[roleTab]); return `<tr><td>${esc(p.label)}</td><td style="text-align:right"><span class="badge ${c}">${l}</span></td></tr>`; }).join('')}</table></div>
      </div>`);
    $$('[data-r]').forEach((b) => b.addEventListener('click', () => { roleTab = b.dataset.r; PAGES.equipe(); }));
    $('#inv').addEventListener('click', () => inviteModal(companies));
    $$('[data-u]').forEach((el) => el.addEventListener('click', () => editUser(users.find((u) => u.id === Number(el.dataset.u)))));
  };
  function roleOptions(sel) { return ['admin', 'gestor', 'funcionario'].filter((r) => me.user.role === 'admin' || r !== 'admin').map((r) => `<option value="${r}" ${r === sel ? 'selected' : ''}>${ROLE[r]}</option>`).join(''); }
  function inviteModal(companies) {
    modal(`<div class="mh"><h2>Convidar pessoa</h2></div><div class="mb">
      <label class="field"><span>Nome</span><input id="nn" maxlength="80"></label><label class="field"><span>E-mail</span><input id="ne" type="email"></label>
      <label class="field"><span>Perfil</span><select id="nr">${roleOptions('funcionario')}</select></label>
      ${me.user.role === 'admin' ? `<label class="field"><span>Empresa</span><select id="nc">${companies.map((c) => `<option value="${c.id}">${esc(c.grp)} · ${esc(c.name)}</option>`).join('')}</select></label>` : ''}</div>
      <div class="mf"><button class="btn" data-close>Cancelar</button><button class="btn primary" id="ns">Convidar</button></div>`, {
      onMount: (el, close) => $('#ns', el).addEventListener('click', async () => {
        try {
          const r = await api('/api/users', { body: { name: $('#nn', el).value, email: $('#ne', el).value, role: $('#nr', el).value, company_id: $('#nc', el)?.value } });
          close();
          modal(`<div class="mh"><h2>Pessoa convidada</h2></div><div class="mb"><p>Envie estes dados por um canal seguro. Ela troca a senha no primeiro acesso.</p>
            <div class="note mono">Endereço: ${esc(location.origin)}<br>E-mail: ${esc($('#ne', el).value)}<br>Senha provisória: ${esc(r.tempPassword)}</div></div>
            <div class="mf"><button class="btn primary" data-close>Pronto</button></div>`);
          PAGES.equipe();
        } catch (e) { toast(e.message, true); }
      }),
    });
  }
  function editUser(u) {
    if (u.id === me.user.id) return toast('Para mudar seus dados, use Minha conta.');
    modal(`<div class="mh"><h2>${esc(u.name)}</h2><div class="muted small">${esc(u.email)}</div></div><div class="mb">
      <label class="field"><span>Perfil</span><select id="er">${roleOptions(u.role)}</select></label>
      <label class="check"><input type="checkbox" id="ea" ${u.active ? 'checked' : ''}> Acesso ativo</label></div>
      <div class="mf"><button class="btn" data-close>Cancelar</button><button class="btn primary" id="es">Salvar</button></div>`, {
      onMount: (el, close) => $('#es', el).addEventListener('click', async () => {
        try { await api(`/api/users/${u.id}`, { method: 'PATCH', body: { role: $('#er', el).value, active: $('#ea', el).checked } }); close(); PAGES.equipe(); } catch (e) { toast(e.message, true); }
      }),
    });
  }

  // ---------- 7.11 Auditoria e gravações ----------
  let audTab = 'sessoes', audSel = null;
  PAGES.auditoria = async () => {
    const isAdmin = me.user.role === 'admin';
    let body = '';
    if (audTab === 'sessoes') {
      const { sessions, blocked } = await api('/api/sessions');
      const rows = sessions.map((s) => ({ ...s, kind: 's', ts: s.started_at })).concat(blocked.map((b) => ({ ...b, kind: 'b', ts: b.started_at }))).sort((a, b) => b.ts - a.ts);
      if (!audSel && sessions[0]) audSel = sessions[0].id;
      const actions = (s) => {
        const a = [s.unattended ? 'Não assistido' : s.permissions.includes('controlar') ? 'Controle' : 'Visualização'];
        if (s.files) a.push(`${s.files} arquivo${s.files > 1 ? 's' : ''}`);
        if (s.recording) a.push('gravada');
        if (s.live) a.push('ao vivo');
        return a.join(', ');
      };
      body = `<div class="grid-side" style="grid-template-columns:minmax(0,1fr) 380px"><div class="card" style="padding:6px 8px"><div class="table-wrap"><table class="t"><thead><tr><th>Quando</th><th>Quem</th><th>Dispositivo</th><th>Duração</th><th>Ações</th><th></th></tr></thead><tbody>
        ${rows.map((r) => r.kind === 's' ? `<tr class="${r.id === audSel ? 'sel' : ''}"><td class="mono small">${new Date(r.ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</td><td><b>${esc(r.tech_name || '—')}</b></td>
          <td>${esc(r.device_name || r.device_id)}</td><td class="mono small">${r.ended_at ? fmtDur(r.ended_at - r.started_at) : 'ao vivo'}</td><td class="small">${esc(actions(r))}</td><td><button class="btn sm" data-s="${r.id}">Detalhes</button></td></tr>`
          : `<tr><td class="mono small">${new Date(r.ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</td><td><b>${esc(r.tech_name || 'Desconhecido')}</b></td><td>${esc(r.device_name || r.device_id)}</td><td>—</td><td class="small" style="color:var(--red)">Bloqueado: 5 senhas erradas</td><td></td></tr>`).join('')
          || '<tr><td colspan="6" class="muted" style="padding:24px;text-align:center">Nenhuma sessão registrada ainda.</td></tr>'}
        </tbody></table></div></div><div class="card" id="detail"><div class="muted small">Escolha uma sessão para ver os detalhes.</div></div></div>`;
    } else {
      const ev = await api('/api/audit?limit=500');
      body = `<div class="card" style="padding:6px 8px"><div class="table-wrap"><table class="t"><thead><tr><th>Quando</th><th>Evento</th><th>Quem</th><th>Dispositivo</th><th>Detalhes</th><th>IP</th><th>Hash</th></tr></thead><tbody>
        ${ev.map((e) => `<tr><td class="mono small">${new Date(e.ts).toLocaleString('pt-BR')}</td><td><b>${esc(e.label)}</b></td><td>${esc(e.actor || '—')}</td><td class="small">${esc(e.device_name || e.device_id || '')}</td>
        <td class="small muted" style="max-width:260px;overflow:hidden;text-overflow:ellipsis">${esc(e.details || '')}</td><td class="mono small muted">${esc(e.ip || '')}</td><td class="mono small muted" title="${esc(e.hash)}">${esc(e.hash.slice(0, 10))}…</td></tr>`).join('')}
        </tbody></table></div></div>`;
    }
    layout('auditoria', `<div class="head"><div><div class="eyebrow">Segurança</div><h1>Auditoria e gravações</h1></div>
      <div class="actions">${isAdmin ? '<button class="btn" id="vfy">Verificar integridade</button>' : ''}<a class="btn" href="/api/audit/export.csv">Exportar CSV</a><button class="btn" id="pdf">Exportar PDF</button></div></div>
      <div class="chips"><button class="chip ${audTab === 'sessoes' ? 'on' : ''}" data-at="sessoes">Sessões</button><button class="chip ${audTab === 'eventos' ? 'on' : ''}" data-at="eventos">Todos os eventos</button></div>${body}`);
    $$('[data-at]').forEach((b) => b.addEventListener('click', () => { audTab = b.dataset.at; PAGES.auditoria(); }));
    $$('[data-s]').forEach((b) => b.addEventListener('click', () => { audSel = b.dataset.s; $$('tr.sel').forEach((r) => r.classList.remove('sel')); b.closest('tr').classList.add('sel'); showSession(audSel); }));
    $('#pdf').addEventListener('click', () => window.print());
    $('#vfy') && $('#vfy').addEventListener('click', async () => {
      const r = await api('/api/audit/verify');
      modal(`<div class="mh"><h2>${r.ok ? 'Registro íntegro' : 'Registro adulterado'}</h2></div><div class="mb">${r.ok ? `<p>Os ${r.count} registros conferem: cada hash encadeia com o anterior e nenhum foi alterado ou apagado.</p>` : `<div class="note danger">A cadeia quebra no registro #${r.brokenAt}. ${r.count} registros anteriores estão íntegros.</div>`}</div><div class="mf"><button class="btn primary" data-close>Fechar</button></div>`);
    });
    if (audTab === 'sessoes' && audSel) showSession(audSel);
  };
  async function showSession(id) {
    const d = $('#detail'); if (!d) return;
    try {
      const s = await api(`/api/sessions/${id}`);
      d.innerHTML = `<h2>${esc(s.device_name || s.device_id)}</h2><div class="muted small" style="margin-bottom:10px">${esc(s.tech_name || '')} · ${new Date(s.started_at).toLocaleString('pt-BR')}${s.route ? ` · ${esc(s.route)}` : ''}</div>
        <div class="rec-preview" id="recp">${s.recording ? '<button class="btn" id="play">▶ Assistir gravação</button>' : `<span class="small">${s.ended_at ? `Sem gravação · ${fmtDur(s.ended_at - s.started_at)}` : 'Sessão em andamento'}</span>`}</div>
        <div class="timeline" style="margin-top:12px">${s.events.map((e) => `<div><span class="mono">${new Date(e.ts).toLocaleTimeString('pt-BR')}</span><span>${esc(e.label)}${e.details ? ` <span class="muted">${esc(fmtDetails(e))}</span>` : ''}</span></div>`).join('')}</div>
        ${s.summary ? `<div class="note small" style="margin-top:10px"><b style="color:var(--violet)">Resumo da Domma IA:</b> ${esc(s.summary)}</div>` : ''}
        <div class="muted small" style="margin-top:12px">Registro imutável com hash encadeado · retenção de 12 meses</div>`;
      $('#play') && $('#play').addEventListener('click', () => { $('#recp').innerHTML = `<video controls autoplay src="/api/sessions/${s.id}/recording"></video>`; });
    } catch (e) { d.innerHTML = `<div class="muted">${esc(e.message)}</div>`; }
  }
  function fmtDetails(e) {
    try {
      const o = JSON.parse(e.details);
      if (o.codigo) return `(código ${o.codigo} confirmado)`;
      if (o.nome) return `${o.nome}${o.bytes ? ' · ' + fmtBytes(o.bytes) : ''}`;
      if (o.por) return `por ${o.por === 'usuario' ? 'usuário' : o.por === 'tecnico' ? 'técnico' : o.por.replace('_', ' ')}`;
      if (o.permissoes) return o.permissoes.join(', ');
      if (o.qualidade) return o.qualidade;
      return '';
    } catch { return e.details; }
  }

  // ---------- 7.12 Planos e licença ----------
  let annual = false;
  PAGES.planos = async () => {
    const { plans, current } = await api('/api/plans');
    layout('planos', `<div class="head"><div><div class="eyebrow">Conta</div><h1>Planos e licença</h1></div>
      <div class="actions"><div class="seg"><button class="${annual ? '' : 'on'}" data-a="0">Mensal</button><button class="${annual ? 'on' : ''}" data-a="1">Anual · 2 meses grátis</button></div></div></div>
      <div class="plans">${Object.entries(plans).map(([k, p]) => `<div class="card plan-card ${k === current ? 'cur' : ''}"><div class="between"><h2>${esc(p.name)}</h2>${k === current ? '<span class="badge">Seu plano</span>' : ''}</div>
        <div class="muted small">${esc(p.desc)}</div><div class="price">R$ ${annual ? p.price * 10 : p.price} <span class="muted small" style="font-family:Manrope">${p.price ? (annual ? '/ano' : '/mês') : 'para sempre'}</span></div>
        <ul>${p.features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
        ${k === current ? '<button class="btn primary block" disabled>Plano atual</button>' : k === 'business' ? '<a class="btn block" style="justify-content:center" href="mailto:?subject=Domma%20View%20Business">Falar com vendas</a>' : `<button class="btn block" data-p="${k}">Mudar para ${esc(p.name)}</button>`}</div>`).join('')}</div>
      <p class="muted small" style="margin-top:16px">Valores sugeridos para validação. A cobrança recorrente por Pix, boleto ou cartão (Asaas) entra no lançamento SaaS; por enquanto a troca de plano só ajusta os limites da conta (ex.: sessões simultâneas). Uso pessoal gratuito tem limite de tempo por sessão.</p>`);
    $$('[data-a]').forEach((b) => b.addEventListener('click', () => { annual = b.dataset.a === '1'; PAGES.planos(); }));
    $$('[data-p]').forEach((b) => b.addEventListener('click', async () => { await api('/api/plans', { body: { plan: b.dataset.p } }); toast('Plano alterado'); me = await api('/api/me'); PAGES.planos(); }));
  };

  // ---------- Minha conta ----------
  PAGES.conta = async () => {
    layout('conta', `<div class="eyebrow">Conta</div><h1>Minha conta</h1><div class="grid2"><div class="card"><h2>${esc(me.user.name)}</h2><p class="muted">${esc(me.user.email)}<br>${ROLE[me.user.role]} · ${esc(me.user.company_name || '')}</p></div>
      <div class="card"><h2>Trocar senha</h2><form id="pf" style="margin-top:12px"><label class="field"><span>Senha atual</span><input name="c" type="password" autocomplete="current-password" required></label>
      <label class="field"><span>Nova senha (mín. 8 caracteres)</span><input name="n" type="password" minlength="8" autocomplete="new-password" required></label><button class="btn primary">Salvar</button></form></div></div>`);
    $('#pf').addEventListener('submit', async (e) => {
      e.preventDefault(); const f = new FormData(e.target);
      try { await api('/api/me/password', { body: { current: f.get('c'), next: f.get('n') } }); toast('Senha alterada'); me = await api('/api/me'); PAGES.conta(); } catch (er) { toast(er.message, true); }
    });
  };

  boot().catch((e) => { root.innerHTML = `<div class="login-wrap"><div class="note danger">${esc(e.message)}</div></div>`; });
})();
