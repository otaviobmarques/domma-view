# Domma View

Sistema de acesso e suporte remoto da Domma Tecnologia, construído a partir do *Descritivo do Sistema v1.1*.
O servidor faz sinalização, contas e auditoria. A tela trafega direto entre os dois computadores por WebRTC
(P2P, cifrada DTLS-SRTP), ou via relay TURN quando o P2P não fecha.

| Parte | Endereço | O que é |
|---|---|---|
| Site | `/` | Página pública: proposta, recursos, segurança, planos |
| Portal de cadastro | `/cadastro` | Cria a conta da empresa, a primeira unidade e o Administrador; devolve o código de vínculo |
| Download | `/download?empresa=CÓDIGO` | Instalador do Windows com o código no nome do arquivo, agente web e QuickSupport |
| Console | `/app` | Técnicos e gestores (seções 7.1 e 7.8 a 7.12) |
| Agente web | `/agente.html` | Recebe suporte pelo navegador (só tela, sem mouse e teclado) |
| Agente Windows | `agent-desktop/` | Instalável: controle de mouse e teclado, inicia com o Windows, não assistido, tela preta, reiniciar |

Cada conta criada no cadastro é isolada: o Administrador vê só as unidades, computadores, pessoas, sessões e
auditoria da própria conta.

## Rodar

Requer Node.js 22.5 ou mais novo (usa o SQLite embutido do Node).

```bash
npm install
```

```bash
ADMIN_EMAIL=voce@empresa.com.br ADMIN_PASSWORD='uma-senha-forte' npm start
```

Abra `http://localhost:3000`. Sem `ADMIN_PASSWORD`, uma senha inicial é gerada e impressa no terminal no primeiro start,
junto com os códigos de empresa do instalador (ex.: `ML-4821-ECV`).

| Variável | Para quê |
|---|---|
| `PORT` | Porta HTTP (padrão 3000) |
| `DATA_DIR` | Pasta do banco, chaves e gravações (padrão `./data`) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | Administrador criado no primeiro start |
| `SESSION_SECRET`, `RECORDING_KEY` | 32 bytes em hex; se ausentes, são gerados em `DATA_DIR` |
| `STUN_URLS` | STUN separados por vírgula (padrão Google) |
| `TURN_URL`, `TURN_USER`, `TURN_PASS` | Relay coturn (recomendado em São Paulo) |
| `NODE_ENV=production` | Cookie `Secure` (exige HTTPS) |
| `WINDOWS_INSTALLER_URL` | De onde baixar o instalador (ex.: `https://github.com/otaviobmarques/domma-view/releases/latest/download/DommaView-Setup.exe`); o servidor guarda uma cópia e entrega com o código da empresa no nome |
| `DOWNLOADS_DIR` | Alternativa: pasta com o `.exe` e um `latest.json` (`{"windows":{"file":"...","version":"1.0.0"}}`) |
| `SALES_EMAIL` | E-mail do botão “Falar com vendas” do plano Business |
| `SEED=off` | Não cria a conta de demonstração Master Laudo no primeiro start |
| `LOG_REQUESTS=1` | Mostra as requisições no terminal |

Em produção é obrigatório HTTPS: navegadores só liberam compartilhamento de tela em origem segura.

## Produção (VPS Hostinger, Campinas)

O servidor roda em `https://view.dommasistemas.com.br`, num VPS da Hostinger em Campinas (SP), como o projeto Docker
`domma-view`. Ele fica atrás do Traefik do VPS, que emite o HTTPS com Let's Encrypt, e ao lado de um coturn (relay TURN
nas portas 3478 e 49160–49260/UDP) com credenciais temporárias.

- Compose: `deploy/docker-compose.yml`. Variáveis do projeto: `DOMINIO`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `TURN_SECRET`,
  `PUBLIC_IP`, `IMAGE_TAG`, `WINDOWS_INSTALLER_URL`.
- Imagem: `ghcr.io/otaviobmarques/domma-view`, publicada pelo workflow `imagem.yml` a cada push (tag = nome do branch;
  `latest` no `main`). Para atualizar o servidor, recrie o projeto no Docker Manager do VPS (puxa a imagem de novo).
- Instalador: workflow `agente-windows.yml`, disparo manual com `server_url` e `release` (ex.: `agente-v1.0.1`).
- DNS (HostGator): registro A `view` → IP do VPS.

## Telas e fluxos

| Descritivo | Onde | Situação |
|---|---|---|
| 7.1 Início | `/#/inicio` | ID do parceiro, senha, modos (controle, arquivos, só visualizar), recentes |
| 7.2 Instalador (5 passos) | `/agente.html?empresa=CÓDIGO` | Termos, empresa, tipo de acesso, instalação, pronto |
| 7.3 QuickSupport | `/suporte` e `/s/<token>` | Marca da empresa, selo verificada, aviso anti-golpe, ID e senha |
| 7.4 Pedido de acesso | janela do agente | Código de confirmação dos dois lados, permissões, 30 s, recusar/permitir |
| 7.5 Sessão remota | console | Tela ao vivo, qualidade, troca de tela, gravação, chat, Sistema, Domma IA, latência/fps/rota |
| 7.6 Arquivos | botão Arquivos | Duas colunas, envio e download pelo canal cifrado, fila com progresso |
| 7.8 Dispositivos | `/#/dispositivos` | Indicadores, filtro por grupo, status, alertas, exportar, link do instalador |
| 7.9 Equipe e permissões | `/#/equipe` | Admin, Gestor, Funcionário; convite com senha provisória |
| 7.10 Fila de suporte | `/#/fila` | SLA verde/amarelo/vermelho, link de uso único (30 min), WhatsApp, técnicos agora, resumo do dia |
| 7.11 Auditoria e gravações | `/#/auditoria` | Sessões, tentativas bloqueadas, linha do tempo, gravação, verificação da cadeia de hash, CSV/PDF |
| 7.12 Planos e licença | `/#/planos` | Pessoal, Solo, Equipe, Business; o limite de sessões simultâneas é aplicado |

## Segurança implementada

- Senha temporária nova a cada sessão; senha fixa do não assistido com scrypt.
- Fora da própria empresa, só entra com senha. Após 5 senhas erradas, o IP fica bloqueado para aquele ID por 24 h (registrado na auditoria).
- Login com bloqueio após 5 erros (15 min). Cookie `HttpOnly` assinado com HMAC.
- Código de confirmação exibido para o técnico e para o usuário antes do aceite.
- Auditoria somente-inserção (triggers bloqueiam UPDATE/DELETE) com hash SHA-256 encadeado e botão de verificação.
- Gravações cifradas em disco com AES-256-GCM; só tocam para quem tem permissão de histórico.
- Agente autenticado por chave própria (o servidor guarda só o hash), então o ID não pode ser clonado.
- Perfis aplicados no servidor: Gestor vê só a própria empresa; Funcionário vê só a própria máquina.

## Agente para Windows (`agent-desktop/`)

Aplicativo Electron que abre o agente do servidor e acrescenta o que o navegador não permite:

- **mouse e teclado remotos** pela API `SendInput` do Windows (via koffi, sem compilar nada). As teclas vão por
  scancode, então o layout do computador remoto (ex.: ABNT2) é respeitado;
- captura de tela sem clique, troca automática de monitor;
- inicia com o Windows e fica no ícone perto do relógio; acesso não assistido de verdade;
- barra fixa no topo durante o acesso, com Encerrar (fora da captura, o técnico não a vê);
- tela preta (escondida da captura), Ctrl+Shift+Esc e reiniciar.

O técnico usa o mesmo console: quando o computador remoto roda o agente Windows e a pessoa liberou
“Controlar mouse e teclado”, a sessão mostra “Controle ativo” e os botões são liberados.

Gerar o instalador (no Windows, ou no Linux com Wine):

```bash
cd agent-desktop && npm ci
```

```bash
DV_SERVER_URL=https://view.suaempresa.com.br npm run dist:win
```

Sai `dist/DommaView-Setup-1.0.0.exe`: instala por usuário, sem pedir administrador. O código da empresa vem do
nome do arquivo (`DommaView-Setup_ML-4821-ECV.exe`, como o site entrega) ou do parâmetro de instalação em massa
`DommaView-Setup.exe /S /EMPRESA=ML-4821-ECV`.

O workflow `.github/workflows/agente-windows.yml` gera o instalador num Windows do GitHub a cada mudança em
`agent-desktop/` (artefato do workflow) e o publica numa Release quando se cria uma tag `agente-v1.0.0`.
Defina a variável de repositório `DV_SERVER_URL` com o endereço do servidor.

### Serviço do Windows (`agent-service/`, Go)

O instalador (por máquina, pede administrador uma vez) instala também o serviço `DommaViewService`, que roda
como Sistema desde a inicialização do Windows:

- **Tela de login sem ninguém logado** (inclusive depois de reiniciar): o computador aparece online e o técnico entra
  se o acesso não assistido estiver ligado. A imagem e o controle vão pelo servidor (JPEG ~5 fps).
- **Tela segura com alguém logado** (UAC, bloqueio, Ctrl+Alt+Del): o console troca sozinho para a imagem do serviço e
  volta ao vídeo normal quando ela some.
- **Ctrl+Alt+Del de verdade** (SendSAS), **bloquear teclado e mouse do cliente** (BlockInput; o Ctrl+Alt+Del físico
  sempre desbloqueia) e **reiniciar**.
- Com o serviço, o mouse e o teclado do técnico também alcançam **janelas de administrador**.

Segurança: o serviço só recebe comandos pela própria conexão autenticada com o servidor (chave do serviço, guardada em
`C:\ProgramData\DommaView`, acessível só a Sistema e Administradores). Localmente, ele só entrega ao app do usuário o
ID e a chave do agente, por um pipe somente leitura, para os dois usarem o mesmo computador no console. Cada comando
segue as permissões que a pessoa liberou na sessão e vai para a auditoria.

```bash
DommaViewService.exe install --server https://view.dommasistemas.com.br --empresa ML-4821-ECV
```

```bash
DommaViewService.exe status
```

O workflow `agente-windows.yml` instala o serviço num Windows de verdade e testa: registro, pipe de chaves, sessão pela
tela de login, quadros, mouse, bloqueio de teclado, Ctrl+Alt+Del (troca para o desktop Winlogon) e a instalação
silenciosa do `.exe` com o serviço.

Limites atuais:

- sem certificado de assinatura de código o Windows mostra “editor desconhecido” (SmartScreen) e alguns antivírus
  podem desconfiar; o certificado EV entra antes do lançamento;
- na tela de login a imagem vai pelo servidor (não P2P) e é mais lenta que o vídeo normal;
- macOS e Linux ainda não têm agente instalável.

## Limites do agente web

O navegador não deixa uma página controlar o computador. Por isso esta versão **transmite a tela, chat,
arquivos e área de transferência**, mas não injeta mouse e teclado. Os botões Ctrl+Alt+Del, bloquear teclado, tela preta,
anotar e reiniciar aparecem desativados, com a explicação. Também por regra do navegador:

- o usuário precisa clicar para liberar a tela (no acesso não assistido, uma vez por abertura do agente);
- o agente funciona enquanto a aba estiver aberta (não inicia com o Windows).

Para esses recursos, instale o agente para Windows no computador.

## Próximos passos sugeridos

1. Certificado EV para assinar o instalador; serviço do Windows para tela de login, UAC e Ctrl+Alt+Del.
2. TURN próprio em São Paulo e métricas de taxa de P2P.
3. Cobrança Asaas, Domma Chat (envio do link) e Domma IA via API para o resumo.
4. PostgreSQL + Redis quando houver mais de uma instância do servidor.
5. Revisão jurídica dos termos, da política de privacidade e do DPA.

## Teste de ponta a ponta

Com o servidor rodando (e o Playwright instalado: `npm i -D playwright && npx playwright install chromium`):

```bash
ADMIN_EMAIL=voce@empresa.com.br ADMIN_PASSWORD='uma-senha-forte' npm test
```

O teste instala um agente, conecta, confere o código dos dois lados, recebe vídeo, troca chat e arquivos nos dois sentidos,
grava, encerra, verifica a auditoria, gera link de suporte, abre o QuickSupport e confere o bloqueio após 5 senhas erradas.
Depois ele abre o site, cria uma conta pelo portal de cadastro e confere que ela não vê nem acessa nada da outra conta.

`node test/agent-desktop-wine.js` roda o `Domma View.exe` no Wine (precisa de Xvfb, Wine e o build em
`agent-desktop/dist/win-unpacked`): assistente, código vindo do nome do instalador, captura sem clique e recursos
anunciados. O Wine deste tipo de ambiente não enxerga placas de rede e trava nas chamadas de cursor, então o
mouse real é conferido pelo autoteste do workflow do GitHub (`agent-desktop/scripts/selftest-input.js`).

Use `SHOTS_DIR=docs/telas` para salvar capturas de tela (as de `docs/telas` foram geradas assim).

## Estrutura

```
server/index.js       API HTTP e páginas
server/signaling.js   WebSocket: presença, pedido de acesso, sessões, repasse WebRTC
server/auth.js        login, perfis e matriz de permissões
server/db.js          SQLite, auditoria com hash, criptografia das gravações
public/js/app.js      console (Início, Dispositivos, Fila, Equipe, Auditoria, Planos)
public/js/sessao.js   sessão remota e arquivos do técnico
public/js/agente.js   instalador, QuickSupport e tela do usuário
public/index.html     site · cadastro.html portal de cadastro · download.html downloads
agent-desktop/        agente para Windows (main.js, input-win.js, preload.js, instalador NSIS)
agent-service/        serviço do Windows em Go (service.go, helper.go, desktop.go)
```
