package model

import "time"

// Creation receipts point to immutable v1 revisions, not a second script store.
type ProjectScriptBatch struct {
	ID              string    `json:"id" gorm:"primaryKey;size:36"`
	ProjectID       string    `json:"projectId" gorm:"size:36;uniqueIndex:idx_script_batch_request,priority:1"`
	RequestID       string    `json:"requestId" gorm:"size:100;uniqueIndex:idx_script_batch_request,priority:2"`
	RequestHash     string    `json:"requestHash" gorm:"size:64"`
	ProjectRevision int64     `json:"projectRevision"`
	UnitIDs         []string  `json:"unitIds" gorm:"serializer:json;type:text"`
	CreatedBy       string    `json:"createdBy" gorm:"size:36"`
	CreatedAt       time.Time `json:"createdAt"`
}
