package service

import (
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestDesktopLocalAuthCreatesAndReusesStableUser(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:"+newID()+"?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.User{}, &model.SystemSetting{}, &model.CreditAccount{}, &model.CreditLedgerEntry{}); err != nil {
		t.Fatal(err)
	}
	svc := NewWithRuntimeCapabilities(
		repository.New(db),
		t.TempDir(),
		RuntimeCapabilitiesForDeployment("127.0.0.1:43101", "false", "true"),
	)

	first, err := svc.CurrentUser("")
	if err != nil {
		t.Fatal(err)
	}
	second, err := svc.CurrentUser("malformed-cookie")
	if err != nil {
		t.Fatal(err)
	}
	if first.ID != desktopLocalUserID || second.ID != desktopLocalUserID {
		t.Fatalf("desktop user ids = %q, %q", first.ID, second.ID)
	}
	if first.Role != model.UserRoleAdmin || first.Status != model.UserStatusActive || first.PasswordHash != "" {
		t.Fatalf("desktop user = %#v", first)
	}
	var count int64
	if err := db.Model(&model.User{}).Where("id = ?", desktopLocalUserID).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("desktop user count = %d, want 1", count)
	}

	settings, err := svc.PublicAuthSettings()
	if err != nil {
		t.Fatal(err)
	}
	if settings.AuthMode != AuthModeDesktopLocal || settings.RegistrationEnabled || settings.FirstUser {
		t.Fatalf("desktop auth settings = %#v", settings)
	}
}

func TestAccountModeStillRequiresSession(t *testing.T) {
	svc := &Service{runtimeCapabilities: RuntimeCapabilities{}}
	if svc.AuthMode() != AuthModeAccount {
		t.Fatalf("auth mode = %q", svc.AuthMode())
	}
	if _, err := svc.CurrentUser(""); err == nil {
		t.Fatal("account mode must reject an empty session")
	}
}
