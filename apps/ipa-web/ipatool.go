package main

import (
	"os"
	"path/filepath"
	"sync"

	cookiejar "github.com/juju/persistent-cookiejar"
	"github.com/majd/ipatool/v2/pkg/appstore"
	"github.com/majd/ipatool/v2/pkg/keychain"
	"github.com/majd/ipatool/v2/pkg/util/machine"
	"github.com/majd/ipatool/v2/pkg/util/operatingsystem"
)

// memoryKeychain holds the session in memory; a restart logs in again
type memoryKeychain struct {
	mu    sync.Mutex
	items map[string][]byte
}

var _ keychain.Keychain = (*memoryKeychain)(nil)

func (k *memoryKeychain) Get(key string) ([]byte, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	data, ok := k.items[key]
	if !ok {
		return nil, os.ErrNotExist
	}
	return data, nil
}

func (k *memoryKeychain) Set(key string, data []byte) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.items[key] = data
	return nil
}

func (k *memoryKeychain) Remove(key string) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	delete(k.items, key)
	return nil
}

// fixedMachine pins the Store hardware identity, since pod MAC addresses change on every restart
type fixedMachine struct {
	machine.Machine
	mac string
}

func (m fixedMachine) MacAddress() (string, error) {
	if m.mac == "" {
		return m.Machine.MacAddress()
	}
	return m.mac, nil
}

func newAppStore(stateDir string) (appstore.AppStore, error) {
	if err := os.MkdirAll(stateDir, 0700); err != nil {
		return nil, err
	}
	jar, err := cookiejar.New(&cookiejar.Options{Filename: filepath.Join(stateDir, "cookies")})
	if err != nil {
		return nil, err
	}
	osys := operatingsystem.New()
	return appstore.NewAppStore(appstore.Args{
		CookieJar:       jar,
		OperatingSystem: osys,
		Keychain:        &memoryKeychain{items: map[string][]byte{}},
		Machine:         fixedMachine{Machine: machine.New(machine.Args{OS: osys}), mac: os.Getenv("MAC_ADDRESS")},
	}), nil
}
