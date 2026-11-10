// Cabeçalho, rodapé e planos do site público.
(() => {
  const { esc, logo } = DV;
  const head = document.getElementById('site-head');
  if (head) head.outerHTML = `<header class="topnav"><div class="wrap">
    <a class="logo" href="/">${logo(28)} Domma View</a>
    <nav><a href="/#recursos">Recursos</a><a href="/#seguranca">Segurança</a><a href="/#planos">Planos</a><a href="/download">Download</a></nav>
    <div class="cta"><a class="btn" href="/app">Entrar</a><a class="btn primary" href="/cadastro">Criar conta</a></div></div></header>`;
  const foot = document.getElementById('site-foot');
  if (foot) foot.outerHTML = `<footer class="site"><div class="wrap"><span>© ${new Date().getFullYear()} Domma Tecnologia · Servidores no Brasil · Conexões cifradas ponta a ponta</span>
    <span><a href="/suporte">QuickSupport</a><a href="/termos.html">Termos de uso</a><a href="/privacidade.html">Privacidade</a></span></div></footer>`;

  const plansBox = document.getElementById('plans');
  if (plansBox) {
    fetch('/api/public/plans').then((r) => r.json()).then(({ plans, salesEmail }) => {
      plansBox.innerHTML = Object.entries(plans).map(([k, p]) => `<div class="card plan-card ${k === 'equipe' ? 'pop' : ''}">
        <h2>${esc(p.name)}</h2><div class="muted small">${esc(p.desc)}</div>
        <div class="price">R$ ${p.price} <span class="muted small" style="font-family:Manrope">${p.price ? '/mês' : 'para sempre'}</span></div>
        <ul>${p.features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
        ${k === 'business' ? (salesEmail ? `<a class="btn block" style="justify-content:center" href="mailto:${esc(salesEmail)}?subject=Domma%20View%20Business">Falar com vendas</a>` : '<button class="btn block" disabled>Sob consulta</button>')
          : `<a class="btn ${k === 'equipe' ? 'primary' : ''} block" style="justify-content:center" href="/cadastro?plano=${k}">${p.price ? `Assinar ${esc(p.name)}` : 'Começar grátis'}</a>`}</div>`).join('');
    }).catch(() => {});
  }
})();
