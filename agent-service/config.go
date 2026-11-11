//go:build windows

// Configuração do serviço em C:\ProgramData\DommaView (só SYSTEM e Administradores leem e escrevem).
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"golang.org/x/sys/windows"
)

type Config struct {
	ServerURL   string `json:"serverUrl"`
	CompanyCode string `json:"companyCode"`
	DeviceID    string `json:"deviceId,omitempty"`
	AgentKey    string `json:"agentKey,omitempty"`
	ServiceKey  string `json:"serviceKey,omitempty"`
	Name        string `json:"name,omitempty"`
	CompanyName string `json:"companyName,omitempty"`
}

var cfgMu sync.Mutex

func dataDir() string {
	pd := os.Getenv("ProgramData")
	if pd == "" {
		pd = `C:\ProgramData`
	}
	return filepath.Join(pd, "DommaView")
}
func configPath() string { return filepath.Join(dataDir(), "service.json") }

// Diretório protegido: só SYSTEM e Administradores (as chaves do serviço ficam aqui).
func ensureDataDir() error {
	if err := os.MkdirAll(dataDir(), 0o700); err != nil {
		return err
	}
	sd, err := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
	if err != nil {
		return err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	return windows.SetNamedSecurityInfo(dataDir(), windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil)
}

func loadConfig() (Config, error) {
	cfgMu.Lock()
	defer cfgMu.Unlock()
	var c Config
	b, err := os.ReadFile(configPath())
	if err != nil {
		return c, err
	}
	err = json.Unmarshal(b, &c)
	return c, err
}

func saveConfig(c Config) error {
	cfgMu.Lock()
	defer cfgMu.Unlock()
	if err := ensureDataDir(); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(c, "", "  ")
	tmp := configPath() + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, configPath())
}

var codeRe = regexp.MustCompile(`[A-Z]{2}-\d{4}-[A-Z]{3}`)

// Aceita o código puro ou o nome do instalador (DommaView-Setup_ML-4821-ECV.exe)
func parseCompanyCode(s string) string {
	return codeRe.FindString(strings.ToUpper(s))
}

func normalizeServer(u string) (string, error) {
	u = strings.TrimRight(strings.TrimSpace(u), "/")
	if !strings.HasPrefix(u, "https://") && !strings.HasPrefix(u, "http://") {
		return "", fmt.Errorf("endereço do servidor inválido: %q", u)
	}
	return u, nil
}

// Log simples em arquivo, cortado em 5 MB
func setupLog(name string) {
	_ = ensureDataDir()
	p := filepath.Join(dataDir(), name)
	if st, err := os.Stat(p); err == nil && st.Size() > 5<<20 {
		_ = os.Rename(p, p+".1")
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err == nil {
		log.SetOutput(f)
	}
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
}
