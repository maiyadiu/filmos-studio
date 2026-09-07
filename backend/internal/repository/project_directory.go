package repository

import (
	"database/sql"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"infinite-canvas/backend/internal/model"
)

type DirectorySnapshot struct {
	Project         model.Project
	Units           []model.ProjectUnit
	Scripts         []model.ProjectUnitRevision
	ScriptBatches   []model.ProjectScriptBatch
	Shots           []model.Shot
	ShotHistory     []model.ShotRevision
	Canvases        []model.CanvasProject
	Prompts         []model.CanvasPromptRevision
	Assets          []model.Asset
	Versions        []model.AssetVersion
	Representations []model.AssetRepresentation
	Folders         []model.ProjectAssetFolder
	References      []model.ShotAssetReference
	CanvasLinks     []model.CanvasUnitLink
	Candidates      []model.ProjectAssetCandidate
	AssetLinks      []model.ProjectAssetLink
	Voices          []model.CharacterVoiceBinding
	Workflows       []model.WorkflowInstance
	Steps           []model.WorkflowStepInstance
}

func (r *Repository) ProjectNameExists(userID, name string) (bool, error) {
	var count int64
	err := r.db.Model(&model.Project{}).Where("user_id = ? AND name = ?", userID, name).Count(&count).Error
	return count > 0, err
}

// nil assetIDs means a whole-library replacement, not a single asset edit.
func (r *Repository) ProjectIDsForAssets(userID string, assetIDs []string) ([]string, error) {
	var ids []string
	query := r.db.Model(&model.ProjectAssetLink{}).Joins("JOIN projects ON projects.id = project_asset_links.project_id").Where("projects.user_id = ?", userID)
	if assetIDs != nil {
		query = query.Where("project_asset_links.asset_id IN ?", assetIDs)
	}
	err := query.Distinct("project_asset_links.project_id").Pluck("project_asset_links.project_id", &ids).Error
	return ids, err
}

func (r *Repository) ProjectDirectorySnapshot(userID, projectID string) (DirectorySnapshot, error) {
	var out DirectorySnapshot
	err := r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("user_id = ? AND id = ?", userID, projectID).First(&out.Project).Error; err != nil {
			return err
		}
		for _, target := range []any{&out.Units, &out.Scripts, &out.ScriptBatches, &out.Shots, &out.ShotHistory} {
			if err := tx.Where("project_id = ?", projectID).Order("id").Find(target).Error; err != nil {
				return err
			}
		}
		for _, target := range []any{&out.Folders, &out.CanvasLinks, &out.Candidates, &out.AssetLinks, &out.Workflows} {
			if err := tx.Where("project_id = ?", projectID).Order("id").Find(target).Error; err != nil {
				return err
			}
		}
		workflowIDs := tx.Model(&model.WorkflowInstance{}).Select("id").Where("project_id = ?", projectID)
		if err := tx.Where("workflow_instance_id IN (?)", workflowIDs).Order("workflow_instance_id, position").Find(&out.Steps).Error; err != nil {
			return err
		}
		var refErr error
		out.References, refErr = New(tx).ProjectShotAssetReferences(projectID)
		if refErr != nil {
			return refErr
		}
		if err := tx.Where("user_id = ? AND project_id = ?", userID, projectID).Order("id").Find(&out.Canvases).Error; err != nil {
			return err
		}
		if err := tx.Where("user_id = ? AND canvas_id IN (?)", userID, tx.Model(&model.CanvasProject{}).Select("id").Where("user_id = ? AND project_id = ?", userID, projectID)).Order("created_at, id").Find(&out.Prompts).Error; err != nil {
			return err
		}
		assetIDs := tx.Model(&model.ProjectAssetLink{}).Select("asset_id").Where("project_id = ?", projectID)
		if err := tx.Where("user_id = ? AND id IN (?)", userID, assetIDs).Order("id").Find(&out.Assets).Error; err != nil {
			return err
		}
		ownedIDs := tx.Model(&model.Asset{}).Select("id").Where("user_id = ? AND id IN (?)", userID, assetIDs)
		if err := tx.Where("asset_id IN (?)", ownedIDs).Order("asset_id, version").Find(&out.Versions).Error; err != nil {
			return err
		}
		versionIDs := tx.Model(&model.AssetVersion{}).Select("id").Where("asset_id IN (?)", ownedIDs)
		if err := tx.Where("asset_version_id IN (?)", versionIDs).Order("id").Find(&out.Voices).Error; err != nil {
			return err
		}
		return tx.Where("asset_version_id IN (?)", versionIDs).Order("id").Find(&out.Representations).Error
	}, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	return out, err
}

func (r *Repository) ProjectDirectory(userID, projectID string) (model.ProjectDirectory, error) {
	var row model.ProjectDirectory
	err := r.db.Where("user_id = ? AND project_id = ?", userID, projectID).First(&row).Error
	return row, err
}

func (r *Repository) ProjectDirectoryRequest(userID, requestID string) (model.ProjectDirectory, error) {
	var row model.ProjectDirectory
	err := r.db.Where("user_id = ? AND request_id = ?", userID, requestID).First(&row).Error
	return row, err
}

func (r *Repository) ReserveProjectDirectory(row model.ProjectDirectory) error {
	return r.db.Clauses(clause.OnConflict{DoNothing: true}).Create(&row).Error
}

func (r *Repository) SetProjectDirectoryState(userID, projectID, state string) error {
	return r.db.Model(&model.ProjectDirectory{}).Where("user_id = ? AND project_id = ?", userID, projectID).Updates(map[string]any{"state": state, "updated_at": time.Now()}).Error
}

func (r *Repository) RelocateProjectDirectory(userID, projectID, previous, next string) error {
	result := r.db.Model(&model.ProjectDirectory{}).Where("user_id = ? AND project_id = ? AND root_path = ?", userID, projectID, previous).Updates(map[string]any{"root_path": next, "state": "pending", "updated_at": time.Now()})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return gorm.ErrRecordNotFound
	}
	return nil
}
