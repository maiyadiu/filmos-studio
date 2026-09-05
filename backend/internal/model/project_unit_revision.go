package model

import "time"

// ProjectUnitRevision is append-only editing history for the existing chapter
// source. It is not a Film Core ScriptVersion, approval, or script lock.
type ProjectUnitRevision struct {
	ID          string            `json:"id" gorm:"primaryKey;size:36"`
	ProjectID   string            `json:"projectId" gorm:"index;size:36"`
	UnitID      string            `json:"unitId" gorm:"size:36;uniqueIndex:idx_unit_revision,priority:1;uniqueIndex:idx_unit_revision_request,priority:1"`
	Revision    int64             `json:"revision" gorm:"uniqueIndex:idx_unit_revision,priority:2"`
	Title       string            `json:"title" gorm:"size:240"`
	SourceText  string            `json:"sourceText,omitempty" gorm:"type:text"`
	SourceHash  string            `json:"sourceHash" gorm:"size:64"`
	Status      ProjectUnitStatus `json:"status" gorm:"size:24"`
	RequestID   string            `json:"requestId" gorm:"size:100;uniqueIndex:idx_unit_revision_request,priority:2"`
	RequestHash string            `json:"-" gorm:"size:64"`
	Note        string            `json:"note" gorm:"size:1000"`
	CreatedBy   string            `json:"createdBy" gorm:"size:36"`
	CreatedAt   time.Time         `json:"createdAt"`
}
