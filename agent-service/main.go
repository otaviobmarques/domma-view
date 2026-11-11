//go:build windows

// DommaViewService.exe
//
//	install --server URL --empresa CÓDIGO   instala e inicia o serviço (precisa de administrador)
//	uninstall                               para e remove o serviço e os dados
//	status                                  mostra o estado do serviço e do registro
//	selftest                                captura a tela e move o cursor (diagnóstico)
//	helper                                  (interno) auxiliar aberto pelo serviço na sessão da tela
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/windows/registry"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

func main() {
	if is, _ := svc.IsWindowsService(); is {
		_ = svc.Run(serviceName, &dvService{})
		return
	}
	if len(os.Args) < 2 {
		fmt.Println("uso: DommaViewService.exe install --server URL --empresa CÓDIGO | uninstall | status | selftest")
		os.Exit(1)
	}
	switch os.Args[1] {
	case "helper":
		runHelper()
	case "install":
		fs := flag.NewFlagSet("install", flag.ExitOnError)
		server := fs.String("server", "", "endereço do servidor")
		empresa := fs.String("empresa", "", "código da empresa (ou nome do instalador)")
		cfgFile := fs.String("config", "", "config.json do app (lê serverUrl)")
		_ = fs.Parse(os.Args[2:])
		exit(install(*server, *empresa, *cfgFile))
	case "uninstall":
		exit(uninstall())
	case "status":
		exit(status())
	case "selftest":
		exit(selftest())
	default:
		fmt.Println("comando desconhecido:", os.Args[1])
		os.Exit(1)
	}
}

func exit(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "erro:", err)
		os.Exit(1)
	}
}

func install(server, empresa, cfgFile string) error {
	if server == "" && cfgFile != "" {
		var c struct{ ServerURL string `json:"serverUrl"` }
		if b, err := os.ReadFile(cfgFile); err == nil && json.Unmarshal(b, &c) == nil {
			server = c.ServerURL
		}
	}
	srv, err := normalizeServer(server)
	if err != nil {
		return err
	}
	if err := ensureDataDir(); err != nil {
		return fmt.Errorf("pasta de dados: %w", err)
	}
	cfg, _ := loadConfig()
	if cfg.ServerURL != srv { // outro servidor: registro novo
		cfg = Config{}
	}
	cfg.ServerURL = srv
	if code := parseCompanyCode(empresa); code != "" {
		if cfg.CompanyCode != code {
			cfg.DeviceID, cfg.AgentKey, cfg.ServiceKey = "", "", ""
		}
		cfg.CompanyCode = code
	}
	if err := saveConfig(cfg); err != nil {
		return err
	}
	// Permite que serviços gerem o Ctrl+Alt+Del (política SoftwareSASGeneration = 1)
	if k, _, err := registry.CreateKey(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System`, registry.SET_VALUE|registry.QUERY_VALUE); err == nil {
		if v, _, e := k.GetIntegerValue("SoftwareSASGeneration"); e != nil || (v != 1 && v != 3) {
			_ = k.SetDWordValue("SoftwareSASGeneration", 1)
		}
		k.Close()
	}
	exe, _ := os.Executable()
	exe, _ = filepath.Abs(exe)
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("gerenciador de serviços (precisa de administrador): %w", err)
	}
	defer m.Disconnect()
	s, err := m.OpenService(serviceName)
	if err == nil {
		_, _ = s.Control(svc.Stop)
		waitState(s, svc.Stopped, 15*time.Second)
		_ = s.UpdateConfig(mgr.Config{
			DisplayName: "Domma View (serviço)", Description: "Suporte remoto Domma View: tela de login, UAC e Ctrl+Alt+Del.",
			StartType: mgr.StartAutomatic, BinaryPathName: fmt.Sprintf(`"%s"`, exe), ServiceStartName: "LocalSystem",
		})
	} else {
		s, err = m.CreateService(serviceName, exe, mgr.Config{
			DisplayName: "Domma View (serviço)", Description: "Suporte remoto Domma View: tela de login, UAC e Ctrl+Alt+Del.",
			StartType: mgr.StartAutomatic, ServiceStartName: "LocalSystem",
		})
		if err != nil {
			return fmt.Errorf("criar serviço: %w", err)
		}
	}
	defer s.Close()
	_ = s.SetRecoveryActions([]mgr.RecoveryAction{
		{Type: mgr.ServiceRestart, Delay: 5 * time.Second}, {Type: mgr.ServiceRestart, Delay: 15 * time.Second}, {Type: mgr.ServiceRestart, Delay: time.Minute},
	}, 86400)
	if err := s.Start(); err != nil && !strings.Contains(err.Error(), "already running") {
		return fmt.Errorf("iniciar serviço: %w", err)
	}
	fmt.Printf("Serviço instalado. Servidor %s, empresa %s.\n", srv, cfg.CompanyCode)
	return nil
}

func waitState(s *mgr.Service, want svc.State, d time.Duration) {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if st, err := s.Query(); err == nil && st.State == want {
			return
		}
		time.Sleep(300 * time.Millisecond)
	}
}

func uninstall() error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	if s, err := m.OpenService(serviceName); err == nil {
		_, _ = s.Control(svc.Stop)
		waitState(s, svc.Stopped, 15*time.Second)
		_ = s.Delete()
		s.Close()
	}
	_ = exec.Command("taskkill", "/F", "/IM", filepath.Base(os.Args[0]), "/FI", fmt.Sprintf("PID ne %d", os.Getpid())).Run()
	_ = os.RemoveAll(dataDir())
	fmt.Println("Serviço removido.")
	return nil
}

func status() error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	state := "não instalado"
	if s, err := m.OpenService(serviceName); err == nil {
		if st, err := s.Query(); err == nil {
			state = map[svc.State]string{svc.Running: "rodando", svc.Stopped: "parado", svc.StartPending: "iniciando", svc.StopPending: "parando"}[st.State]
		}
		s.Close()
	}
	cfg, _ := loadConfig()
	fmt.Printf("serviço: %s\nservidor: %s\nempresa: %s\ncomputador: %s %s\n", state, cfg.ServerURL, cfg.CompanyCode, cfg.DeviceID, cfg.Name)
	return nil
}

func selftest() error {
	d := NewDesk()
	fmt.Println("desktop:", d.Name())
	jpg, w, h, err := d.Capture(1600, 55)
	if err != nil {
		return fmt.Errorf("captura: %w", err)
	}
	fmt.Printf("quadro: %dx%d, %d KB\n", w, h, len(jpg)/1024)
	d.Input(InputMsg{K: "move", X: 0.3, Y: 0.6})
	time.Sleep(200 * time.Millisecond)
	x, y := d.CursorPos()
	fmt.Printf("cursor depois de mover para 30%%/60%%: %d,%d\n", x, y)
	return nil
}
