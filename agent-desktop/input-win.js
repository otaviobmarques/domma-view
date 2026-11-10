// Entrada remota no Windows: SendInput (user32) via FFI, sem compilar nada.
// Teclas vão por scancode (posição física), então o layout do computador remoto (ex.: ABNT2) é respeitado.
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');

const MOUSEINPUT = koffi.struct('DV_MOUSEINPUT', {
  dx: 'long', dy: 'long', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr',
});
const KEYBDINPUT = koffi.struct('DV_KEYBDINPUT', {
  wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr',
});
const HARDWAREINPUT = koffi.struct('DV_HARDWAREINPUT', { uMsg: 'uint32', wParamL: 'uint16', wParamH: 'uint16' });
const INPUT = koffi.struct('DV_INPUT', {
  type: 'uint32',
  u: koffi.union('DV_INPUT_U', { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT }),
});

const SendInput = user32.func('uint32 __stdcall SendInput(uint32 cInputs, DV_INPUT *pInputs, int cbSize)');
const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int nIndex)');
const SetWindowDisplayAffinity = user32.func('bool __stdcall SetWindowDisplayAffinity(intptr hWnd, uint32 dwAffinity)');
const INPUT_SIZE = koffi.sizeof(INPUT);

const MOUSE = { MOVE: 0x0001, LDOWN: 0x0002, LUP: 0x0004, RDOWN: 0x0008, RUP: 0x0010, MDOWN: 0x0020, MUP: 0x0040, WHEEL: 0x0800, HWHEEL: 0x1000, VIRTUALDESK: 0x4000, ABSOLUTE: 0x8000 };
const KEY = { EXTENDED: 0x0001, UP: 0x0002, SCANCODE: 0x0008 };
const BTN = { 0: ['LDOWN', 'LUP'], 1: ['MDOWN', 'MUP'], 2: ['RDOWN', 'RUP'] };

// KeyboardEvent.code -> [scancode set 1, estendida]
const SC = {
  Escape: [0x01], Digit1: [0x02], Digit2: [0x03], Digit3: [0x04], Digit4: [0x05], Digit5: [0x06], Digit6: [0x07], Digit7: [0x08], Digit8: [0x09], Digit9: [0x0a], Digit0: [0x0b],
  Minus: [0x0c], Equal: [0x0d], Backspace: [0x0e], Tab: [0x0f], KeyQ: [0x10], KeyW: [0x11], KeyE: [0x12], KeyR: [0x13], KeyT: [0x14], KeyY: [0x15], KeyU: [0x16], KeyI: [0x17],
  KeyO: [0x18], KeyP: [0x19], BracketLeft: [0x1a], BracketRight: [0x1b], Enter: [0x1c], ControlLeft: [0x1d], KeyA: [0x1e], KeyS: [0x1f], KeyD: [0x20], KeyF: [0x21], KeyG: [0x22],
  KeyH: [0x23], KeyJ: [0x24], KeyK: [0x25], KeyL: [0x26], Semicolon: [0x27], Quote: [0x28], Backquote: [0x29], ShiftLeft: [0x2a], Backslash: [0x2b], KeyZ: [0x2c], KeyX: [0x2d],
  KeyC: [0x2e], KeyV: [0x2f], KeyB: [0x30], KeyN: [0x31], KeyM: [0x32], Comma: [0x33], Period: [0x34], Slash: [0x35], ShiftRight: [0x36], NumpadMultiply: [0x37], AltLeft: [0x38],
  Space: [0x39], CapsLock: [0x3a], F1: [0x3b], F2: [0x3c], F3: [0x3d], F4: [0x3e], F5: [0x3f], F6: [0x40], F7: [0x41], F8: [0x42], F9: [0x43], F10: [0x44], NumLock: [0x45, 1],
  ScrollLock: [0x46], Numpad7: [0x47], Numpad8: [0x48], Numpad9: [0x49], NumpadSubtract: [0x4a], Numpad4: [0x4b], Numpad5: [0x4c], Numpad6: [0x4d], NumpadAdd: [0x4e],
  Numpad1: [0x4f], Numpad2: [0x50], Numpad3: [0x51], Numpad0: [0x52], NumpadDecimal: [0x53], IntlBackslash: [0x56], F11: [0x57], F12: [0x58], IntlRo: [0x73], NumpadComma: [0x7e],
  NumpadEnter: [0x1c, 1], ControlRight: [0x1d, 1], NumpadDivide: [0x35, 1], PrintScreen: [0x37, 1], AltRight: [0x38, 1], Home: [0x47, 1], ArrowUp: [0x48, 1], PageUp: [0x49, 1],
  ArrowLeft: [0x4b, 1], ArrowRight: [0x4d, 1], End: [0x4f, 1], ArrowDown: [0x50, 1], PageDown: [0x51, 1], Insert: [0x52, 1], Delete: [0x53, 1], MetaLeft: [0x5b, 1], MetaRight: [0x5c, 1],
  ContextMenu: [0x5d, 1],
};

function send(inp) { return SendInput(1, inp, INPUT_SIZE); }
function mouse(flags, extra = {}) {
  return send({ type: 0, u: { mi: { dx: extra.dx || 0, dy: extra.dy || 0, mouseData: (extra.data || 0) >>> 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } } });
}
function key(code, down) {
  const k = SC[code];
  if (!k) return 0;
  let flags = KEY.SCANCODE | (k[1] ? KEY.EXTENDED : 0) | (down ? 0 : KEY.UP);
  return send({ type: 1, u: { ki: { wVk: 0, wScan: k[0], dwFlags: flags, time: 0, dwExtraInfo: 0 } } });
}

// rect: retângulo da tela capturada em pixels físicos { x, y, width, height }
function absolute(nx, ny, rect) {
  const vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
  const px = rect.x + Math.min(Math.max(nx, 0), 1) * (rect.width - 1);
  const py = rect.y + Math.min(Math.max(ny, 0), 1) * (rect.height - 1);
  return { dx: Math.round(((px - vx) * 65535) / Math.max(1, vw - 1)), dy: Math.round(((py - vy) * 65535) / Math.max(1, vh - 1)) };
}
const MOVE_ABS = MOUSE.MOVE | MOUSE.ABSOLUTE | MOUSE.VIRTUALDESK;

function handle(m, rect) {
  switch (m.k) {
    case 'move': return mouse(MOVE_ABS, absolute(m.x, m.y, rect));
    case 'down': case 'up': {
      const b = BTN[m.b] || BTN[0];
      mouse(MOVE_ABS, absolute(m.x, m.y, rect));
      return mouse(MOUSE[m.k === 'down' ? b[0] : b[1]]);
    }
    case 'wheel':
      if (m.dy) mouse(MOUSE.WHEEL, { data: Math.max(-1200, Math.min(1200, m.dy | 0)) });
      if (m.dx) mouse(MOUSE.HWHEEL, { data: Math.max(-1200, Math.min(1200, m.dx | 0)) });
      return 1;
    case 'key': return key(String(m.code), !!m.down);
    case 'combo': {
      const codes = (Array.isArray(m.codes) ? m.codes : []).slice(0, 4).map(String);
      codes.forEach((c) => key(c, true));
      codes.slice().reverse().forEach((c) => key(c, false));
      return 1;
    }
  }
  return 0;
}

// Esconde uma janela da captura de tela (Windows 10 2004+), para a tela preta e a barra de conexão
function excludeFromCapture(hwndBuffer) {
  try {
    const hwnd = hwndBuffer.length >= 8 ? Number(hwndBuffer.readBigUInt64LE(0)) : hwndBuffer.readUInt32LE(0);
    return SetWindowDisplayAffinity(hwnd, 0x11);
  } catch { return false; }
}

module.exports = { handle, excludeFromCapture, SC };
