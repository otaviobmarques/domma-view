// Grava o endereço do servidor dentro do instalador: DV_SERVER_URL=https://view.suaempresa.com.br npm run dist:win
const fs = require('fs');
const path = require('path');
const url = (process.env.DV_SERVER_URL || 'http://localhost:3000').replace(/\/+$/, '');
fs.writeFileSync(path.join(__dirname, '..', 'config.json'), JSON.stringify({ serverUrl: url }, null, 2) + '\n');
console.log('Servidor do agente:', url);
