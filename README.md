# Domma View — MVP web

Sistema de acesso e suporte remoto da Domma Tecnologia, construído a partir do *Descritivo do Sistema v1.1*.
Esta versão roda inteira no navegador: o servidor faz sinalização, contas e auditoria. A tela trafega
direto entre os dois computadores por WebRTC (P2P, cifrada DTLS-SRTP), ou via relay TURN quando o P2P não fecha.

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

Em produção é obrigatório HTTPS: navegadores só liberam compartilhamento de tela em origem segura.

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

## Limites do agente web

O navegador não deixa uma página controlar o computador. Por isso esta versão **transmite a tela, chat,
arquivos e área de transferência**, mas não injeta mouse e teclado. Os botões Ctrl+Alt+Del, bloquear teclado, tela preta,
anotar e reiniciar aparecem desativados, com a explicação. Também por regra do navegador:

- o usuário precisa clicar para liberar a tela (no acesso não assistido, uma vez por abertura do agente);
- o agente funciona enquanto a aba estiver aberta (não inicia com o Windows).

Esses itens dependem do **agente nativo** (Fase 0 do roadmap: Rust + DXGI/ScreenCaptureKit/PipeWire + SendInput/CGEvent/uinput).
O protocolo de sinalização e o canal de dados já estão prontos para recebê-lo: o agente nativo só precisa falar o mesmo
WebSocket (`hello`, `accept`, `signal`…) e WebRTC.

## Próximos passos sugeridos

1. Agente nativo para Windows (captura + entrada + serviço), assinado com certificado EV.
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
```
