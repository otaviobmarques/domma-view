// Planos sugeridos (seção 8). Valores para validação antes do lançamento.
const PLANS = {
  pessoal:  { name: 'Pessoal',  price: 0,   sessions: 1,  techs: 1,    devices: 3,    sessionMinutes: 30, desc: 'Ajudar a família, uso não comercial',
    features: ['1 técnico, 1 sessão', 'Sessões de até 30 min', 'Controle, chat e arquivos', 'Celular como controle'] },
  solo:     { name: 'Solo',     price: 59,  sessions: 1,  techs: 1,    devices: 200,  desc: 'Profissional autônomo de TI',
    features: ['1 técnico, 1 sessão', 'Até 200 dispositivos', 'Acesso não assistido', 'Gravação 30 dias', 'Link de suporte'] },
  equipe:   { name: 'Equipe',   price: 189, sessions: 3,  techs: 5,    devices: 1000, desc: 'Times de suporte e redes de lojas',
    features: ['Até 5 técnicos, 3 sessões', '1.000 dispositivos', 'Perfis e permissões', 'Fila de suporte + Domma Chat', 'QuickSupport com sua marca', 'Resumo por Domma IA'] },
  business: { name: 'Business', price: 449, sessions: 10, techs: 9999, devices: 99999, desc: 'Empresas, franqueadoras e MSPs',
    features: ['Técnicos ilimitados, 10 sessões', 'Dispositivos ilimitados', 'SSO, API e webhooks', 'Auditoria 12 meses', 'Servidor próprio (on-premise) opcional'] },
};
module.exports = { PLANS };
