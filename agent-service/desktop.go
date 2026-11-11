//go:build windows

// Operações na área de trabalho ativa (inclusive a tela segura do Winlogon: login, UAC, Ctrl+Alt+Del):
// troca de desktop, captura GDI, SendInput e BlockInput. Tudo roda numa única thread do SO,
// porque o desktop é por thread (SetThreadDesktop).
package main

import (
	"bytes"
	"errors"
	"image"
	"image/jpeg"
	"log"
	"runtime"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	user32 = windows.NewLazySystemDLL("user32.dll")
	gdi32  = windows.NewLazySystemDLL("gdi32.dll")

	pOpenInputDesktop      = user32.NewProc("OpenInputDesktop")
	pSetThreadDesktop      = user32.NewProc("SetThreadDesktop")
	pCloseDesktop          = user32.NewProc("CloseDesktop")
	pGetUserObjectInfo     = user32.NewProc("GetUserObjectInformationW")
	pGetSystemMetrics      = user32.NewProc("GetSystemMetrics")
	pGetDC                 = user32.NewProc("GetDC")
	pReleaseDC             = user32.NewProc("ReleaseDC")
	pSendInput             = user32.NewProc("SendInput")
	pBlockInput            = user32.NewProc("BlockInput")
	pGetCursorInfo         = user32.NewProc("GetCursorInfo")
	pDrawIconEx            = user32.NewProc("DrawIconEx")
	pSetProcessDpiAwareCtx = user32.NewProc("SetProcessDpiAwarenessContext")
	pSetProcessDPIAware    = user32.NewProc("SetProcessDPIAware")
	pGetCursorPos          = user32.NewProc("GetCursorPos")

	pCreateCompatibleDC     = gdi32.NewProc("CreateCompatibleDC")
	pCreateCompatibleBitmap = gdi32.NewProc("CreateCompatibleBitmap")
	pSelectObject           = gdi32.NewProc("SelectObject")
	pBitBlt                 = gdi32.NewProc("BitBlt")
	pGetDIBits              = gdi32.NewProc("GetDIBits")
	pDeleteObject           = gdi32.NewProc("DeleteObject")
	pDeleteDC               = gdi32.NewProc("DeleteDC")
)

const (
	smXVirtual, smYVirtual, smCXVirtual, smCYVirtual = 76, 77, 78, 79
	srccopy, captureblt                              = 0x00CC0020, 0x40000000
	genericAll                                       = 0x10000000
	uoiName                                          = 2

	mMove, mLDown, mLUp, mRDown, mRUp, mMDown, mMUp = 0x0001, 0x0002, 0x0004, 0x0008, 0x0010, 0x0020, 0x0040
	mWheel, mHWheel, mVirtualDesk, mAbsolute        = 0x0800, 0x1000, 0x4000, 0x8000
	kExtended, kUp, kScancode                       = 0x0001, 0x0002, 0x0008
)

type mouseInput struct {
	dx, dy                   int32
	mouseData, dwFlags, time uint32
	extra                    uintptr
}
type inputMouse struct {
	typ uint32
	_   uint32
	mi  mouseInput
}
type keybdInput struct {
	wVk, wScan     uint16
	dwFlags, time  uint32
	extra          uintptr
}
type inputKeybd struct {
	typ uint32
	_   uint32
	ki  keybdInput
	_   [8]byte
}

type bitmapInfoHeader struct {
	biSize                       uint32
	biWidth, biHeight            int32
	biPlanes, biBitCount         uint16
	biCompression, biSizeImage   uint32
	biXPelsPerMeter, biYPelsPer  int32
	biClrUsed, biClrImportant    uint32
}
type cursorInfo struct {
	cbSize, flags uint32
	hCursor       uintptr
	x, y          int32
}

func init() {
	// Coordenadas em pixels reais (sem virtualização de DPI)
	if pSetProcessDpiAwareCtx.Find() == nil {
		pSetProcessDpiAwareCtx.Call(^uintptr(3)) // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 (-4)
	} else {
		pSetProcessDPIAware.Call()
	}
}

func metric(i int) int32 { r, _, _ := pGetSystemMetrics.Call(uintptr(i)); return int32(r) }

// Desk: dona da thread travada que executa tudo que depende do desktop
type Desk struct {
	jobs    chan func()
	current uintptr
	name    string
	blocked bool
}

func NewDesk() *Desk {
	d := &Desk{jobs: make(chan func(), 64)}
	go func() {
		runtime.LockOSThread()
		for job := range d.jobs {
			d.sync()
			job()
		}
	}()
	return d
}

// Do executa fn na thread do desktop e espera terminar
func (d *Desk) Do(fn func()) {
	done := make(chan struct{})
	d.jobs <- func() { fn(); close(done) }
	<-done
}

// sync passa a thread para o desktop que está recebendo a entrada agora (Default ou Winlogon)
func (d *Desk) sync() {
	h, _, _ := pOpenInputDesktop.Call(0, 0, genericAll)
	if h == 0 {
		return
	}
	name := deskName(h)
	if name == d.name && d.current != 0 {
		pCloseDesktop.Call(h)
		return
	}
	if r, _, err := pSetThreadDesktop.Call(h); r == 0 {
		log.Printf("SetThreadDesktop(%s): %v", name, err)
		pCloseDesktop.Call(h)
		return
	}
	if d.current != 0 {
		pCloseDesktop.Call(d.current)
	}
	d.current, d.name = h, name
}

func deskName(h uintptr) string {
	buf := make([]uint16, 256)
	var need uint32
	pGetUserObjectInfo.Call(h, uoiName, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)*2), uintptr(unsafe.Pointer(&need)))
	return windows.UTF16ToString(buf)
}

// Name devolve o nome do desktop de entrada atual
func (d *Desk) Name() (n string) { d.Do(func() { n = d.name }); return }

// Capture tira um quadro da tela inteira (todos os monitores) já em JPEG
func (d *Desk) Capture(maxW int, quality int) (jpg []byte, w, h int, err error) {
	d.Do(func() { jpg, w, h, err = captureNow(maxW, quality) })
	return
}

func captureNow(maxW, quality int) ([]byte, int, int, error) {
	x, y, w, h := metric(smXVirtual), metric(smYVirtual), metric(smCXVirtual), metric(smCYVirtual)
	if w <= 0 || h <= 0 {
		return nil, 0, 0, errors.New("tela sem tamanho")
	}
	screen, _, _ := pGetDC.Call(0)
	if screen == 0 {
		return nil, 0, 0, errors.New("GetDC falhou")
	}
	defer pReleaseDC.Call(0, screen)
	mem, _, _ := pCreateCompatibleDC.Call(screen)
	defer pDeleteDC.Call(mem)
	bmp, _, _ := pCreateCompatibleBitmap.Call(screen, uintptr(w), uintptr(h))
	defer pDeleteObject.Call(bmp)
	old, _, _ := pSelectObject.Call(mem, bmp)
	if r, _, e := pBitBlt.Call(mem, 0, 0, uintptr(w), uintptr(h), screen, uintptr(x), uintptr(y), srccopy|captureblt); r == 0 {
		pSelectObject.Call(mem, old)
		return nil, 0, 0, e
	}
	// desenha o ponteiro do mouse no quadro
	ci := cursorInfo{cbSize: uint32(unsafe.Sizeof(cursorInfo{}))}
	if r, _, _ := pGetCursorInfo.Call(uintptr(unsafe.Pointer(&ci))); r != 0 && ci.flags&1 != 0 {
		pDrawIconEx.Call(mem, uintptr(ci.x-x), uintptr(ci.y-y), ci.hCursor, 0, 0, 0, 0, 3)
	}
	pSelectObject.Call(mem, old)
	bi := bitmapInfoHeader{biSize: 40, biWidth: w, biHeight: -h, biPlanes: 1, biBitCount: 32}
	pix := make([]byte, int(w)*int(h)*4)
	if r, _, e := pGetDIBits.Call(mem, bmp, 0, uintptr(h), uintptr(unsafe.Pointer(&pix[0])), uintptr(unsafe.Pointer(&bi)), 0); r == 0 {
		return nil, 0, 0, e
	}
	img := toRGBA(pix, int(w), int(h), maxW)
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: quality}); err != nil {
		return nil, 0, 0, err
	}
	return buf.Bytes(), img.Rect.Dx(), img.Rect.Dy(), nil
}

// BGRA → RGBA, reduzindo pela metade (média 2×2) enquanto passar de maxW
func toRGBA(pix []byte, w, h, maxW int) *image.RGBA {
	step := 1
	for w/step > maxW && step < 8 {
		step *= 2
	}
	ow, oh := w/step, h/step
	img := image.NewRGBA(image.Rect(0, 0, ow, oh))
	for oy := 0; oy < oh; oy++ {
		for ox := 0; ox < ow; ox++ {
			var r, g, b, n int
			for dy := 0; dy < step; dy++ {
				row := (oy*step + dy) * w * 4
				for dx := 0; dx < step; dx++ {
					i := row + (ox*step+dx)*4
					b += int(pix[i]); g += int(pix[i+1]); r += int(pix[i+2]); n++
				}
			}
			o := img.PixOffset(ox, oy)
			img.Pix[o], img.Pix[o+1], img.Pix[o+2], img.Pix[o+3] = uint8(r/n), uint8(g/n), uint8(b/n), 255
		}
	}
	return img
}

// ---------- entrada ----------

type InputMsg struct {
	K     string   `json:"k"`
	X     float64  `json:"x"`
	Y     float64  `json:"y"`
	AX    *float64 `json:"ax"` // pixels reais na tela virtual (vindo da tela que o agente do usuário captura)
	AY    *float64 `json:"ay"`
	B     int      `json:"b"`
	DX    int      `json:"dx"`
	DY    int      `json:"dy"`
	Code  string   `json:"code"`
	Down  bool     `json:"down"`
	Codes []string `json:"codes"`
}

func sendMouse(flags uint32, dx, dy int32, data int32) {
	in := inputMouse{typ: 0, mi: mouseInput{dx: dx, dy: dy, mouseData: uint32(data), dwFlags: flags}}
	pSendInput.Call(1, uintptr(unsafe.Pointer(&in)), unsafe.Sizeof(in))
}
func sendKey(code string, down bool) {
	k, ok := scancodes[code]
	if !ok {
		return
	}
	flags := uint32(kScancode)
	if k.ext {
		flags |= kExtended
	}
	if !down {
		flags |= kUp
	}
	in := inputKeybd{typ: 1, ki: keybdInput{wScan: k.sc, dwFlags: flags}}
	pSendInput.Call(1, uintptr(unsafe.Pointer(&in)), unsafe.Sizeof(in))
}
func absXY(nx, ny float64) (int32, int32) {
	clamp := func(v float64) float64 {
		if v < 0 {
			return 0
		}
		if v > 1 {
			return 1
		}
		return v
	}
	// o quadro cobre a tela virtual inteira, então x/y normalizados já são relativos a ela
	return int32(clamp(nx)*65535 + 0.5), int32(clamp(ny)*65535 + 0.5)
}

// Input aplica uma mensagem de mouse/teclado no desktop de entrada atual (inclusive Winlogon)
func (d *Desk) Input(m InputMsg) {
	d.Do(func() {
		if m.AX != nil && m.AY != nil { // pixels → fração da tela virtual
			vx, vy, vw, vh := float64(metric(smXVirtual)), float64(metric(smYVirtual)), float64(metric(smCXVirtual)), float64(metric(smCYVirtual))
			if vw > 1 && vh > 1 {
				m.X, m.Y = (*m.AX-vx)/(vw-1), (*m.AY-vy)/(vh-1)
			}
		}
		move := uint32(mMove | mAbsolute | mVirtualDesk)
		switch m.K {
		case "move":
			x, y := absXY(m.X, m.Y)
			sendMouse(move, x, y, 0)
		case "down", "up":
			x, y := absXY(m.X, m.Y)
			sendMouse(move, x, y, 0)
			flag := map[int][2]uint32{0: {mLDown, mLUp}, 1: {mMDown, mMUp}, 2: {mRDown, mRUp}}[m.B]
			if flag[0] == 0 {
				flag = [2]uint32{mLDown, mLUp}
			}
			if m.K == "down" {
				sendMouse(flag[0], 0, 0, 0)
			} else {
				sendMouse(flag[1], 0, 0, 0)
			}
		case "wheel":
			lim := func(v int) int32 {
				if v > 1200 {
					v = 1200
				}
				if v < -1200 {
					v = -1200
				}
				return int32(v)
			}
			if m.DY != 0 {
				sendMouse(mWheel, 0, 0, lim(m.DY))
			}
			if m.DX != 0 {
				sendMouse(mHWheel, 0, 0, lim(m.DX))
			}
		case "key":
			sendKey(m.Code, m.Down)
		case "combo":
			codes := m.Codes
			if len(codes) > 4 {
				codes = codes[:4]
			}
			for _, c := range codes {
				sendKey(c, true)
			}
			for i := len(codes) - 1; i >= 0; i-- {
				sendKey(codes[i], false)
			}
		}
	})
}

// Block liga/desliga o bloqueio do teclado e mouse físicos (o técnico continua controlando).
// O Windows desfaz o bloqueio sozinho com Ctrl+Alt+Del, por segurança.
func (d *Desk) Block(on bool) (err error) {
	d.Do(func() {
		v := uintptr(0)
		if on {
			v = 1
		}
		if r, _, e := pBlockInput.Call(v); r == 0 {
			err = e
			return
		}
		d.blocked = on
	})
	return
}

// CursorPos (para testes): posição atual do cursor em pixels reais
func (d *Desk) CursorPos() (x, y int32) {
	d.Do(func() {
		var p struct{ X, Y int32 }
		pGetCursorPos.Call(uintptr(unsafe.Pointer(&p)))
		x, y = p.X, p.Y
	})
	return
}
