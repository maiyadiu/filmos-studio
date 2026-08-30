package service

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestDesktopUserConfigUsesAtomicVersionedNoSecretRepository(t *testing.T) {
	svc := &Service{dataDir: t.TempDir(), runtimeCapabilities: RuntimeCapabilities{desktopLocalAuth: true}}
	initial, err := svc.ReadDesktopUserConfig("local-user")
	if err != nil {
		t.Fatal(err)
	}
	if initial.EntityVersion != 0 || initial.ContentHash == "" {
		t.Fatalf("unexpected empty config: %#v", initial)
	}
	payload := json.RawMessage(`{"brain_generation_routing":{"schemaVersion":1,"globalDefaultProfileId":"codex.subscription","bindings":[]}}`)
	written, err := svc.WriteDesktopUserConfig("local-user", DesktopUserConfigWrite{ExpectedVersion: initial.EntityVersion, ExpectedContentHash: initial.ContentHash, Payload: payload})
	if err != nil {
		t.Fatal(err)
	}
	if written.EntityVersion != 1 || written.ContentHash == initial.ContentHash {
		t.Fatalf("version/hash did not advance: %#v", written)
	}
	reloaded, err := svc.ReadDesktopUserConfig("local-user")
	if err != nil || reloaded.ContentHash != written.ContentHash {
		t.Fatalf("config did not recover: %#v %v", reloaded, err)
	}
	if _, err := svc.WriteDesktopUserConfig("local-user", DesktopUserConfigWrite{ExpectedVersion: 0, ExpectedContentHash: initial.ContentHash, Payload: payload}); err == nil {
		t.Fatal("expected stale optimistic write rejection")
	}
	updatedPayload := json.RawMessage(`{"brain_generation_routing":{"schemaVersion":1,"globalDefaultProfileId":"chatgpt.subscription.host","bindings":[]}}`)
	updated, err := svc.WriteDesktopUserConfig("local-user", DesktopUserConfigWrite{ExpectedVersion: written.EntityVersion, ExpectedContentHash: written.ContentHash, Payload: updatedPayload})
	if err != nil || updated.EntityVersion != 2 {
		t.Fatalf("second write failed: %#v %v", updated, err)
	}
	entries, err := os.ReadDir(filepath.Join(svc.dataDir, "user-config", "journal"))
	if err != nil || len(entries) != 2 {
		t.Fatalf("migration journal missing: %v %v", entries, err)
	}
	rolledBack, err := svc.RollbackDesktopUserConfig("local-user", updated.EntityVersion, updated.ContentHash)
	var rolledBackValue, expectedValue any
	_ = json.Unmarshal(rolledBack.Payload, &rolledBackValue)
	_ = json.Unmarshal(payload, &expectedValue)
	if err != nil || rolledBack.EntityVersion != 3 || !reflect.DeepEqual(rolledBackValue, expectedValue) {
		t.Fatalf("rollback did not restore the previous payload monotonically: %#v %v", rolledBack, err)
	}
}

func TestDesktopUserConfigRejectsSecretsAndPublicRuntime(t *testing.T) {
	public := &Service{dataDir: t.TempDir()}
	if _, err := public.ReadDesktopUserConfig("user"); err == nil {
		t.Fatal("public runtime must be rejected")
	}
	svc := &Service{dataDir: t.TempDir(), runtimeCapabilities: RuntimeCapabilities{desktopLocalAuth: true}}
	initial, err := svc.ReadDesktopUserConfig("user")
	if err != nil {
		t.Fatal(err)
	}
	for _, payload := range []string{
		`{"apiKey":"secret"}`,
		`{"nested":{"runtime_key":"secret"}}`,
		`{"aliasMapping":{"opaque":"real"}}`,
	} {
		if _, err := svc.WriteDesktopUserConfig("user", DesktopUserConfigWrite{ExpectedVersion: initial.EntityVersion, ExpectedContentHash: initial.ContentHash, Payload: json.RawMessage(payload)}); err == nil {
			t.Fatalf("expected secret rejection for %s", payload)
		}
	}
}
