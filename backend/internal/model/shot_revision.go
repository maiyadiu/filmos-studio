package model

import "time"

// Creative fields belong to the existing business Shot, not canvas metadata.
type ShotSourceReference struct {
	ParagraphID string `json:"paragraphId"`
	Quote       string `json:"quote"`
}

type ShotDialogue struct {
	Speaker     string `json:"speaker"`
	Text        string `json:"text"`
	ParagraphID string `json:"paragraphId"`
}

type ShotContent struct {
	SourceReferences []ShotSourceReference `json:"sourceReferences"`
	Scene            string                `json:"scene"`
	Characters       []string              `json:"characters"`
	Dialogue         []ShotDialogue        `json:"dialogue"`
	Action           string                `json:"action"`
	Camera           string                `json:"camera"`
}

// Append-only snapshots and idempotency receipts in the same project database.
type ShotRevision struct {
	ID          string    `json:"id" gorm:"primaryKey;size:36"`
	ProjectID   string    `json:"projectId" gorm:"index;size:36"`
	UnitID      string    `json:"unitId" gorm:"index;size:36"`
	ShotID      string    `json:"shotId" gorm:"size:36;uniqueIndex:idx_shot_revision,priority:1"`
	Revision    int64     `json:"revision" gorm:"uniqueIndex:idx_shot_revision,priority:2"`
	Snapshot    Shot      `json:"shot" gorm:"serializer:json;type:text"`
	ContentHash string    `json:"contentHash" gorm:"size:64"`
	RequestID   string    `json:"requestId" gorm:"size:100"`
	CreatedBy   string    `json:"createdBy" gorm:"size:36"`
	CreatedAt   time.Time `json:"createdAt"`
}

type ShotBatchReceipt struct {
	ID                 string    `json:"id" gorm:"primaryKey;size:36"`
	ProjectID          string    `json:"projectId" gorm:"index;size:36"`
	UnitID             string    `json:"unitId" gorm:"size:36;uniqueIndex:idx_shot_batch_request,priority:1"`
	RequestID          string    `json:"requestId" gorm:"size:100;uniqueIndex:idx_shot_batch_request,priority:2"`
	RequestHash        string    `json:"requestHash" gorm:"size:64"`
	ShotRevision       int64     `json:"shotRevision"`
	SourceRevision     int64     `json:"sourceRevision"`
	SourceHash         string    `json:"sourceHash" gorm:"size:64"`
	Shots              []Shot    `json:"shots" gorm:"serializer:json;type:text"`
	SourceParagraphIDs []string  `json:"sourceParagraphIds" gorm:"serializer:json;type:text"`
	CreatedBy          string    `json:"createdBy" gorm:"size:36"`
	CreatedAt          time.Time `json:"createdAt"`
}
