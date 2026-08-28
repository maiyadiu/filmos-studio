package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWorkbenchHandlerServesSPAAndAssets(t *testing.T) {
	root := t.TempDir()
	mustWriteTestFile(t, filepath.Join(root, "index.html"), "<html>FilmOS shell</html>")
	mustWriteTestFile(t, filepath.Join(root, "assets", "app.js"), "window.filmos = true")
	backendOrigin, _ := url.Parse("http://127.0.0.1:43101")
	server := httptest.NewServer(newWorkbenchHandler(root, backendOrigin))
	defer server.Close()

	for _, testCase := range []struct {
		path       string
		wantStatus int
		wantBody   string
	}{
		{path: "/create", wantStatus: http.StatusOK, wantBody: "FilmOS shell"},
		{path: "/assets/app.js", wantStatus: http.StatusOK, wantBody: "window.filmos = true"},
		{path: "/assets/missing.js", wantStatus: http.StatusNotFound, wantBody: "404 page not found"},
	} {
		response, err := http.Get(server.URL + testCase.path)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if response.StatusCode != testCase.wantStatus || !strings.Contains(string(body), testCase.wantBody) {
			t.Fatalf("%s: status=%d body=%q", testCase.path, response.StatusCode, body)
		}
	}
}

func TestRuntimeAddressValidationRejectsNonLoopback(t *testing.T) {
	if _, err := validateListenAddress("0.0.0.0:43100"); err == nil {
		t.Fatal("expected public listen address to be rejected")
	}
	if _, err := validateBackendOrigin("http://192.168.1.2:43101"); err == nil {
		t.Fatal("expected private-network backend origin to be rejected")
	}
}

func mustWriteTestFile(t *testing.T, filename, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(filename), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filename, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}
