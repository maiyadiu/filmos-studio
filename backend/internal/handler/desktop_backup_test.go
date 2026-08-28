package handler

import (
	"net/http"
	"testing"
)

func TestDesktopBackupRequiresExplicitIPv4LoopbackPeer(t *testing.T) {
	for _, testCase := range []struct {
		remoteAddr string
		allowed    bool
	}{
		{remoteAddr: "127.0.0.1:54321", allowed: true},
		{remoteAddr: "[::1]:54321", allowed: false},
		{remoteAddr: "192.168.1.10:54321", allowed: false},
		{remoteAddr: "", allowed: false},
	} {
		request := &http.Request{RemoteAddr: testCase.remoteAddr}
		if allowed := requestIsExplicitLoopback(request); allowed != testCase.allowed {
			t.Fatalf("remote=%q allowed=%v", testCase.remoteAddr, allowed)
		}
	}
}
