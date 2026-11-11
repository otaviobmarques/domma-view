//go:build windows

// Serviço do Windows (LocalSystem, sessão 0): registra o computador, mantém o auxiliar rodando
// na sessão da tela (troca de usuário, login, bloqueio), entrega as chaves ao app do usuário
// e executa o Ctrl+Alt+Del (SendSAS), que só um serviço pode chamar.
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
)

const (
	serviceName = "DommaViewService"
	ctlPipe     = `\\.\pipe\DommaViewSvcCtl`
	credsPipe   = `\\.\pipe\DommaViewCreds`
)

var (
	sasDLL   = windows.NewLazySystemDLL("sas.dll")
	pSendSAS = sasDLL.NewProc("SendSAS")
)

type dvService struct {
	mu     sync.Mutex
	helper *windows.ProcessInformation
	hsess  uint32
	quit   chan struct{}
}

func (s *dvService) Execute(args []string, req <-chan svc.ChangeRequest, st chan<- svc.Status) (bool, uint32) {
	st <- svc.Status{State: svc.StartPending}
	s.quit = make(chan struct{})
	go s.run()
	st <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown | svc.AcceptSessionChange}
	for c := range req {
		switch c.Cmd {
		case svc.Interrogate:
			st <- c.CurrentStatus
		case svc.SessionChange:
			s.checkHelper() // login, logoff, troca de usuário: reabre o auxiliar na sessão certa
		case svc.Stop, svc.Shutdown:
			st <- svc.Status{State: svc.StopPending}
			close(s.quit)
			s.killHelper()
			return false, 0
		}
	}
	return false, 0
}

func (s *dvService) run() {
	setupLog("service.log")
	log.Printf("serviço %s iniciando", version)
	go listenCtl()
	go listenCreds()
	for {
		if err := ensureRegistered(); err != nil {
			log.Printf("registro: %v", err)
			select {
			case <-s.quit:
				return
			case <-time.After(30 * time.Second):
				continue
			}
		}
		break
	}
	t := time.NewTicker(2 * time.Second)
	defer t.Stop()
	for {
		s.checkHelper()
		select {
		case <-s.quit:
			return
		case <-t.C:
		}
	}
}

// ensureRegistered cria o computador no servidor na primeira vez (código da empresa vindo do instalador)
func ensureRegistered() error {
	cfg, err := loadConfig()
	if err != nil {
		return fmt.Errorf("sem configuração: %w", err)
	}
	if cfg.DeviceID != "" && cfg.ServiceKey != "" {
		return nil
	}
	if cfg.CompanyCode == "" {
		return fmt.Errorf("sem código da empresa; rode: DommaViewService.exe install --server URL --empresa CÓDIGO")
	}
	host, _ := os.Hostname()
	body, _ := json.Marshal(map[string]string{"companyCode": cfg.CompanyCode, "name": host, "os": "Windows"})
	cl := &http.Client{Timeout: 20 * time.Second}
	r, err := cl.Post(cfg.ServerURL+"/api/agent/service-register", "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer r.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(r.Body, 1<<16))
	if r.StatusCode != 200 {
		return fmt.Errorf("servidor %d: %s", r.StatusCode, strings.TrimSpace(string(raw)))
	}
	var out struct {
		DeviceID, AgentKey, ServiceKey, Name string
		Company                              struct{ Name string }
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return err
	}
	cfg.DeviceID, cfg.AgentKey, cfg.ServiceKey, cfg.Name, cfg.CompanyName = out.DeviceID, out.AgentKey, out.ServiceKey, out.Name, out.Company.Name
	log.Printf("registrado como %s em %s", out.DeviceID, out.Company.Name)
	return saveConfig(cfg)
}

func (s *dvService) checkHelper() {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess := windows.WTSGetActiveConsoleSessionId()
	if s.helper != nil {
		ev, _ := windows.WaitForSingleObject(s.helper.Process, 0)
		alive := ev == uint32(windows.WAIT_TIMEOUT)
		if alive && s.hsess == sess {
			return
		}
		if alive {
			log.Printf("sessão da tela mudou (%d → %d)", s.hsess, sess)
			_ = windows.TerminateProcess(s.helper.Process, 0)
		} else {
			var code uint32
			_ = windows.GetExitCodeProcess(s.helper.Process, &code)
			log.Printf("auxiliar saiu (código %d)", code)
			if code == 3 { // servidor não reconhece mais: registra de novo
				if cfg, err := loadConfig(); err == nil {
					cfg.DeviceID, cfg.AgentKey, cfg.ServiceKey = "", "", ""
					_ = saveConfig(cfg)
					_ = ensureRegistered()
				}
			}
		}
		windows.CloseHandle(s.helper.Process)
		windows.CloseHandle(s.helper.Thread)
		s.helper = nil
	}
	if sess == 0xFFFFFFFF {
		return // nenhuma sessão de console agora
	}
	if cfg, err := loadConfig(); err != nil || cfg.ServiceKey == "" {
		return
	}
	pi, err := spawnHelper(sess)
	if err != nil {
		log.Printf("abrir auxiliar na sessão %d: %v", sess, err)
		return
	}
	s.helper, s.hsess = pi, sess
	log.Printf("auxiliar aberto na sessão %d (pid %d)", sess, pi.ProcessId)
}

func (s *dvService) killHelper() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.helper != nil {
		_ = windows.TerminateProcess(s.helper.Process, 0)
		windows.CloseHandle(s.helper.Process)
		windows.CloseHandle(s.helper.Thread)
		s.helper = nil
	}
}

// spawnHelper abre "DommaViewService.exe helper" como SYSTEM na sessão indicada, no WinSta0
func spawnHelper(session uint32) (*windows.ProcessInformation, error) {
	var tok windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_ALL_ACCESS, &tok); err != nil {
		return nil, err
	}
	defer tok.Close()
	var dup windows.Token
	if err := windows.DuplicateTokenEx(tok, windows.MAXIMUM_ALLOWED, nil, windows.SecurityImpersonation, windows.TokenPrimary, &dup); err != nil {
		return nil, err
	}
	defer dup.Close()
	if err := windows.SetTokenInformation(dup, windows.TokenSessionId, (*byte)(unsafe.Pointer(&session)), 4); err != nil {
		return nil, fmt.Errorf("SetTokenInformation: %w", err)
	}
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	cmd, _ := windows.UTF16PtrFromString(fmt.Sprintf(`"%s" helper`, exe))
	desk, _ := windows.UTF16PtrFromString(`winsta0\default`)
	si := windows.StartupInfo{Desktop: desk}
	si.Cb = uint32(unsafe.Sizeof(si))
	pi := new(windows.ProcessInformation)
	const createNoWindow = 0x08000000
	if err := windows.CreateProcessAsUser(dup, nil, cmd, nil, nil, false, createNoWindow|windows.CREATE_UNICODE_ENVIRONMENT, nil, nil, &si, pi); err != nil {
		return nil, err
	}
	return pi, nil
}

// Pipe de controle: só SYSTEM (o auxiliar). Comando "sas" = Ctrl+Alt+Del de verdade.
func listenCtl() {
	l, err := winio.ListenPipe(ctlPipe, &winio.PipeConfig{SecurityDescriptor: "D:P(A;;GA;;;SY)"})
	if err != nil {
		log.Printf("pipe de controle: %v", err)
		return
	}
	for {
		c, err := l.Accept()
		if err != nil {
			continue
		}
		go func(c net.Conn) {
			defer c.Close()
			_ = c.SetDeadline(time.Now().Add(10 * time.Second))
			line, _ := bufio.NewReader(c).ReadString('\n')
			switch strings.TrimSpace(line) {
			case "sas":
				r, _, e := pSendSAS.Call(0) // FALSE = chamado por serviço
				_ = r
				if e != nil && e != syscall.Errno(0) {
					log.Printf("SendSAS: %v", e)
				}
				fmt.Fprintln(c, "ok")
				log.Printf("Ctrl+Alt+Del enviado")
			default:
				fmt.Fprintln(c, "comando desconhecido")
			}
		}(c)
	}
}

// Pipe de chaves: o app do usuário (Domma View) lê aqui o ID e a chave do agente deste computador.
// Só leitura para usuários interativos; nenhum comando é aceito por aqui.
func listenCreds() {
	l, err := winio.ListenPipe(credsPipe, &winio.PipeConfig{SecurityDescriptor: "D:P(A;;GA;;;SY)(A;;0x120089;;;IU)", MessageMode: false})
	if err != nil {
		log.Printf("pipe de chaves: %v", err)
		return
	}
	for {
		c, err := l.Accept()
		if err != nil {
			continue
		}
		go func(c net.Conn) {
			defer c.Close()
			_ = c.SetDeadline(time.Now().Add(5 * time.Second))
			cfg, err := loadConfig()
			if err != nil || cfg.AgentKey == "" {
				fmt.Fprint(c, `{"ready":false}`)
				return
			}
			b, _ := json.Marshal(map[string]any{
				"ready": true, "deviceId": cfg.DeviceID, "agentKey": cfg.AgentKey, "name": cfg.Name,
				"company": map[string]string{"name": cfg.CompanyName, "code": cfg.CompanyCode}, "serverUrl": cfg.ServerURL,
			})
			_, _ = c.Write(b)
		}(c)
	}
}
