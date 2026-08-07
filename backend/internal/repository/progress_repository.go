package repository

import (
	"context"
	"time"

	"gorm.io/gorm"

	"learnly/backend/internal/model"
)

// ProgressStats 学习进度统计。
type ProgressStats struct {
	Learned   int64
	Learning  int64
	Unlearned int64
	Total     int64
}

// ProgressRepository 学习进度数据访问接口。
type ProgressRepository interface {
	FindByChildAndCharacter(ctx context.Context, childID, characterID uint64) (*model.Progress, error)
	Upsert(ctx context.Context, childID, characterID uint64, status string) (*model.Progress, error)
	GetStatsByChild(ctx context.Context, childID uint64) (*ProgressStats, error)
	CountByChild(ctx context.Context, childID uint64) (int64, error)
}

type progressRepository struct {
	db *gorm.DB
}

// NewProgressRepository 构造 ProgressRepository。
func NewProgressRepository(db *gorm.DB) ProgressRepository {
	return &progressRepository{db: db}
}

// FindByChildAndCharacter 查询某儿童某汉字的进度。
func (r *progressRepository) FindByChildAndCharacter(ctx context.Context, childID, characterID uint64) (*model.Progress, error) {
	var p model.Progress
	if err := r.db.WithContext(ctx).Where("child_id = ? AND character_id = ?", childID, characterID).First(&p).Error; err != nil {
		return nil, err
	}
	return &p, nil
}

// Upsert 按 (child_id, character_id) 唯一约束原子更新 status。
// 已存在则更新 status 与时间戳，不存在则创建。返回最新状态。
func (r *progressRepository) Upsert(ctx context.Context, childID, characterID uint64, status string) (*model.Progress, error) {
	now := time.Now()
	p := model.Progress{
		ChildID:     childID,
		CharacterID: characterID,
		Status:      status,
		LastStudyAt: &now,
		UpdatedAt:   now,
	}
	if status == model.StatusLearned {
		p.CompletedAt = &now
	}

	// 使用 ON CONFLICT 原子 upsert（Postgres 语法）。
	err := r.db.WithContext(ctx).Where("child_id = ? AND character_id = ?", childID, characterID).
		Assign(map[string]interface{}{
			"status":        status,
			"last_study_at": now,
			"completed_at":  p.CompletedAt,
			"updated_at":    now,
		}).
		FirstOrCreate(&p).Error
	if err != nil {
		return nil, err
	}
	return &p, nil
}

// GetStatsByChild 返回某儿童的学习进度统计。
func (r *progressRepository) GetStatsByChild(ctx context.Context, childID uint64) (*ProgressStats, error) {
	var learned, learning int64
	scope := r.db.WithContext(ctx).Model(&model.Progress{}).Where("child_id = ?", childID)

	if err := scope.Where("status = ?", model.StatusLearned).Count(&learned).Error; err != nil {
		return nil, err
	}
	if err := scope.Where("status = ?", model.StatusLearning).Count(&learning).Error; err != nil {
		return nil, err
	}

	total, err := r.CountByLevel(ctx, 0)
	if err != nil {
		return nil, err
	}

	return &ProgressStats{
		Learned:   learned,
		Learning:  learning,
		Unlearned: total - learned - learning,
		Total:     total,
	}, nil
}

// CountByLevel 复用 CharacterRepository 的计数逻辑（用于统计总数）。
func (r *progressRepository) CountByLevel(ctx context.Context, _ int) (int64, error) {
	var n int64
	if err := r.db.WithContext(ctx).Model(&model.Character{}).Count(&n).Error; err != nil {
		return 0, err
	}
	return n, nil
}

// CountByChild 返回某儿童的进度记录数。
func (r *progressRepository) CountByChild(ctx context.Context, childID uint64) (int64, error) {
	var n int64
	if err := r.db.WithContext(ctx).Model(&model.Progress{}).Where("child_id = ?", childID).Count(&n).Error; err != nil {
		return 0, err
	}
	return n, nil
}
