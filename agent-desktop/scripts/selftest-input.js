// Autoteste no Windows: move o cursor pelo mesmo caminho do controle remoto (SendInput) e confere com GetCursorPos.
const koffi = require('koffi');
const input = require('../input-win');
const user32 = koffi.load('user32.dll');
const POINT = koffi.struct('DV_POINT', { x: 'long', y: 'long' });
const GetCursorPos = user32.func('bool __stdcall GetCursorPos(_Out_ DV_POINT *p)');
const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int nIndex)');
const w = GetSystemMetrics(0), h = GetSystemMetrics(1);
const rect = { x: 0, y: 0, width: w, height: h };
let ok = true;
for (const [fx, fy] of [[0.25, 0.75], [0.8, 0.2], [0.5, 0.5]]) {
  input.handle({ k: 'move', x: fx, y: fy }, rect);
  const p = {}; GetCursorPos(p);
  const ex = Math.round(fx * (w - 1)), ey = Math.round(fy * (h - 1));
  const good = Math.abs(p.x - ex) <= 2 && Math.abs(p.y - ey) <= 2;
  ok = ok && good;
  console.log(`${good ? 'OK ' : 'ERRO'} esperado ${ex},${ey} · cursor ${p.x},${p.y} (tela ${w}x${h})`);
}
console.log(Object.keys(input.SC).length, 'teclas mapeadas por scancode');
process.exit(ok ? 0 : 1);
