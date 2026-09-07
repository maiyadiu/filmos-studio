package model

import "time"

// ProjectDirectory binds only new local projects. Existing projects have no row
// and keep their storage unchanged. Paths never travel through public Project JSON.
type ProjectDirectory struct {
	ProjectID   string `gorm:"primaryKey;size:36"`
	UserID      string `gorm:"size:36;uniqueIndex:idx_project_directory_request,priority:1"`
	RequestID   string `gorm:"size:100;uniqueIndex:idx_project_directory_request,priority:2"`
	RequestHash string `gorm:"size:64"`
	RootPath    string `gorm:"type:text"`
	State       string `gorm:"size:24"`
	CreatedAt   time.Time
	UpdatedAt   time.Time
}
