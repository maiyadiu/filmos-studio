package main

import (
	"errors"
	"fmt"
	"log"
	"mime"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

const (
	defaultListenAddress = "127.0.0.1:43100"
	defaultBackendOrigin = "http://127.0.0.1:43101"
)

func main() {
	root, err := validateWebRoot(os.Getenv("FILMOS_WEB_ROOT"))
	if err != nil {
		log.Fatal(err)
	}
	listenAddress, err := validateListenAddress(envOrDefault("FILMOS_WEB_ADDR", defaultListenAddress))
	if err != nil {
		log.Fatal(err)
	}
	backendOrigin, err := validateBackendOrigin(envOrDefault("FILMOS_BACKEND_ORIGIN", defaultBackendOrigin))
	if err != nil {
		log.Fatal(err)
	}

	server := &http.Server{
		Addr:              listenAddress,
		Handler:           newWorkbenchHandler(root, backendOrigin),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       90 * time.Second,
	}
	log.Printf("FilmOS desktop web listening on %s", listenAddress)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func newWorkbenchHandler(root string, backendOrigin *url.URL) http.Handler {
	proxy := httputil.NewSingleHostReverseProxy(backendOrigin)
	proxy.ErrorHandler = func(response http.ResponseWriter, request *http.Request, err error) {
		http.Error(response, "FilmOS local backend is unavailable", http.StatusBadGateway)
	}

	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/api" || strings.HasPrefix(request.URL.Path, "/api/") ||
			request.URL.Path == "/oauth/linuxdo/callback" {
			proxy.ServeHTTP(response, request)
			return
		}
		serveWorkbenchFile(response, request, root)
	})
}

func serveWorkbenchFile(response http.ResponseWriter, request *http.Request, root string) {
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		response.Header().Set("Allow", "GET, HEAD")
		http.Error(response, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	cleanPath := path.Clean("/" + request.URL.Path)
	relativePath := strings.TrimPrefix(cleanPath, "/")
	if relativePath == "" {
		relativePath = "index.html"
	}
	candidate := filepath.Join(root, filepath.FromSlash(relativePath))
	if !isFile(candidate) {
		if path.Ext(relativePath) != "" {
			http.NotFound(response, request)
			return
		}
		candidate = filepath.Join(root, "index.html")
	}

	file, err := os.Open(candidate)
	if err != nil {
		http.NotFound(response, request)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		http.NotFound(response, request)
		return
	}

	if contentType := mime.TypeByExtension(filepath.Ext(candidate)); contentType != "" {
		response.Header().Set("Content-Type", contentType)
	}
	response.Header().Set("X-Content-Type-Options", "nosniff")
	if filepath.Base(candidate) == "index.html" {
		response.Header().Set("Cache-Control", "no-store")
	} else {
		response.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	}
	http.ServeContent(response, request, filepath.Base(candidate), info.ModTime(), file)
}

func validateWebRoot(rawPath string) (string, error) {
	if rawPath == "" || !filepath.IsAbs(rawPath) || strings.ContainsRune(rawPath, '\x00') {
		return "", errors.New("FILMOS_WEB_ROOT must be an absolute directory")
	}
	root, err := filepath.EvalSymlinks(filepath.Clean(rawPath))
	if err != nil {
		return "", fmt.Errorf("resolve FILMOS_WEB_ROOT: %w", err)
	}
	if !isFile(filepath.Join(root, "index.html")) {
		return "", errors.New("FILMOS_WEB_ROOT does not contain index.html")
	}
	return root, nil
}

func validateListenAddress(address string) (string, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil || host != "127.0.0.1" || port == "" {
		return "", errors.New("FILMOS_WEB_ADDR must use 127.0.0.1 with an explicit port")
	}
	return net.JoinHostPort(host, port), nil
}

func validateBackendOrigin(rawOrigin string) (*url.URL, error) {
	origin, err := url.Parse(rawOrigin)
	if err != nil || origin.Scheme != "http" || origin.Hostname() != "127.0.0.1" ||
		origin.Port() == "" || origin.User != nil || (origin.Path != "" && origin.Path != "/") ||
		origin.RawQuery != "" || origin.Fragment != "" {
		return nil, errors.New("FILMOS_BACKEND_ORIGIN must be an HTTP 127.0.0.1 origin with an explicit port")
	}
	return origin, nil
}

func isFile(filename string) bool {
	info, err := os.Stat(filename)
	return err == nil && info.Mode().IsRegular()
}

func envOrDefault(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}
