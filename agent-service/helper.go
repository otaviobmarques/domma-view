//go:build windows

// Auxiliar: roda como SYSTEM na sessão da tela (aberto pelo serviço). Conecta ao servidor com a chave
// do serviço e atende: quadros da tela (login, UAC, bloqueio), mouse/teclado, Ctrl+Alt+Del,
// bloqueio de teclado e reinício. Não aceita comandos de nenhum programa local.
package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/Microsoft/go-winio"
	"github.com/gorilla/websocket"
)

const version = "1.0.0"

type wsMsg struct {
	Type   string          `json:"type"`
	SID    string          `json:"sid,omitempty"`
	On     bool            `json:"on,omitempty"`
	FPS    int             `json:"fps,omitempty"`
	Op     string          `json:"op,omitempty"`
	M      json.RawMessage `json:"m,omitempty"`
	Relay  bool            `json:"relay,omitempty"`
	Code   string          `json:"code,omitempty"`
	Msg    string          `json:"message,omitempty"`
}

type helper struct {
	cfg    Config
	desk   *Desk
	conn   *websocket.Conn
	wmu    sync.Mutex
	fmu    sync.Mutex
	frames map[string]chan struct{}
	active string
	lastDesk string
}

func runHelper() {
	setupLog("helper.log")
	log.Printf("auxiliar %s iniciando", version)
	cfg, err := loadConfig()
	if err != nil || cfg.DeviceID == "" || cfg.ServiceKey == "" {
		log.Printf("sem registro ainda (%v); saindo", err)
		os.Exit(2)
	}
	h := &helper{cfg: cfg, desk: NewDesk(), frames: map[string]chan struct{}{}}
	backoff := time.Second
	for {
		start := time.Now()
		if err := h.session(); err != nil {
			log.Printf("conexão: %v", err)
		}
		h.cleanup()
		if time.Since(start) > time.Minute {
			backoff = time.Second
		}
		time.Sleep(backoff)
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}

func wsURL(server string) string {
	if strings.HasPrefix(server, "https://") {
		return "wss://" + strings.TrimPrefix(server, "https://") + "/ws"
	}
	return "ws://" + strings.TrimPrefix(server, "http://") + "/ws"
}

func (h *helper) send(v any) error {
	h.wmu.Lock()
	defer h.wmu.Unlock()
	if h.conn == nil {
		return errors.New("sem conexão")
	}
	_ = h.conn.SetWriteDeadline(time.Now().Add(15 * time.Second))
	return h.conn.WriteJSON(v)
}

func (h *helper) session() error {
	d := websocket.Dialer{Proxy: http.ProxyFromEnvironment, HandshakeTimeout: 15 * time.Second}
	c, _, err := d.Dial(wsURL(h.cfg.ServerURL), http.Header{"User-Agent": {"DommaViewService/" + version}})
	if err != nil {
		return err
	}
	c.SetReadLimit(1 << 20)
	h.wmu.Lock()
	h.conn = c
	h.wmu.Unlock()
	defer c.Close()

	name := h.desk.Name()
	h.lastDesk = name
	host, _ := os.Hostname()
	if err := h.send(map[string]any{
		"type": "hello-service", "deviceId": h.cfg.DeviceID, "serviceKey": h.cfg.ServiceKey,
		"desktop": name, "secure": isSecure(name),
		"sysinfo": map[string]any{"os": "Windows", "hostname": host, "agent": "Serviço Domma View " + version},
	}); err != nil {
		return err
	}
	log.Printf("conectado a %s como %s (desktop %s)", h.cfg.ServerURL, h.cfg.DeviceID, name)

	stop := make(chan struct{})
	defer close(stop)
	go h.watchDesktop(stop)
	go func() { // mantém a conexão viva através de proxies
		t := time.NewTicker(25 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				h.wmu.Lock()
				_ = c.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second))
				h.wmu.Unlock()
			}
		}
	}()

	for {
		var m wsMsg
		if err := c.ReadJSON(&m); err != nil {
			return err
		}
		h.handle(m)
	}
}

func isSecure(desk string) bool { return desk != "" && !strings.EqualFold(desk, "Default") }

func (h *helper) watchDesktop(stop chan struct{}) {
	t := time.NewTicker(700 * time.Millisecond)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			n := h.desk.Name()
			if n != h.lastDesk {
				log.Printf("desktop: %s → %s", h.lastDesk, n)
				h.lastDesk = n
				_ = h.send(map[string]any{"type": "desktop", "name": n, "secure": isSecure(n)})
			}
		}
	}
}

func (h *helper) handle(m wsMsg) {
	switch m.Type {
	case "welcome-service":
		log.Printf("servidor aceitou o serviço")
	case "error":
		log.Printf("servidor: %s (%s)", m.Msg, m.Code)
		if m.Code == "unknown_device" {
			os.Exit(3) // o serviço decide se registra de novo
		}
	case "session-start":
		h.active = m.SID
	case "session-end":
		h.stopFrames(m.SID)
		if h.active == m.SID {
			h.active = ""
		}
		h.unblock()
	case "frames":
		if m.On {
			h.startFrames(m.SID, m.FPS)
		} else {
			h.stopFrames(m.SID)
		}
	case "priv":
		if m.SID == "" || m.SID != h.active {
			return
		}
		h.priv(m)
	}
}

func (h *helper) priv(m wsMsg) {
	res := map[string]any{"type": "priv-result", "sid": m.SID, "op": m.Op, "ok": true}
	switch m.Op {
	case "input":
		var in InputMsg
		if json.Unmarshal(m.M, &in) == nil {
			h.desk.Input(in)
		}
		return // sem resposta: é contínuo
	case "block":
		if err := h.desk.Block(m.On); err != nil {
			res["ok"], res["error"] = false, err.Error()
		}
	case "sas":
		if err := askService("sas"); err != nil {
			res["ok"], res["error"] = false, err.Error()
		}
	case "reboot":
		h.unblock()
		if err := exec.Command("shutdown", "/r", "/t", "5", "/c", "Reinício solicitado pelo suporte (Domma View)").Start(); err != nil {
			res["ok"], res["error"] = false, err.Error()
		}
	default:
		return
	}
	log.Printf("priv %s on=%v ok=%v", m.Op, m.On, res["ok"])
	_ = h.send(res)
}

func (h *helper) startFrames(sid string, fps int) {
	h.fmu.Lock()
	defer h.fmu.Unlock()
	if _, ok := h.frames[sid]; ok {
		return
	}
	if fps <= 0 || fps > 15 {
		fps = 5
	}
	stop := make(chan struct{})
	h.frames[sid] = stop
	go func() {
		t := time.NewTicker(time.Second / time.Duration(fps))
		defer t.Stop()
		var last [32]byte
		lastSent := time.Time{}
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				jpg, w, hh, err := h.desk.Capture(1600, 55)
				if err != nil {
					log.Printf("captura: %v", err)
					continue
				}
				sum := sha256.Sum256(jpg)
				if sum == last && time.Since(lastSent) < 3*time.Second {
					continue // tela parada: não reenvia
				}
				last, lastSent = sum, time.Now()
				_ = h.send(map[string]any{"type": "frame", "sid": sid, "w": w, "h": hh, "data": base64.StdEncoding.EncodeToString(jpg)})
			}
		}
	}()
}

func (h *helper) stopFrames(sid string) {
	h.fmu.Lock()
	defer h.fmu.Unlock()
	if c, ok := h.frames[sid]; ok {
		close(c)
		delete(h.frames, sid)
	}
}

func (h *helper) unblock() {
	if h.desk.blocked {
		_ = h.desk.Block(false)
	}
}

func (h *helper) cleanup() {
	h.fmu.Lock()
	for sid, c := range h.frames {
		close(c)
		delete(h.frames, sid)
	}
	h.fmu.Unlock()
	h.unblock() // nunca deixa o teclado do cliente preso se a conexão cair
	h.active = ""
	h.wmu.Lock()
	h.conn = nil
	h.wmu.Unlock()
}

// Pede ao serviço (sessão 0) o que só um serviço pode fazer: o Ctrl+Alt+Del (SendSAS).
// O pipe só aceita SYSTEM.
func askService(cmd string) error {
	timeout := 5 * time.Second
	c, err := winio.DialPipe(ctlPipe, &timeout)
	if err != nil {
		return err
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(10 * time.Second))
	if _, err := c.Write([]byte(cmd + "\n")); err != nil {
		return err
	}
	buf := make([]byte, 256)
	n, err := c.Read(buf)
	if err != nil {
		return err
	}
	if r := strings.TrimSpace(string(buf[:n])); r != "ok" {
		return errors.New(r)
	}
	return nil
}
