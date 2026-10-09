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
	TouchLastStudy(ctx context.Context, childID, characterID uint64) (*model.Progress, error)
	GetStatsByChild(ctx context.Context, childID uint64) (*ProgressStats, error)
	CountByChild(ctx context.Context, childID uint64) (int64, error)
	ListByChildAndCharacterIDs(ctx context.Context, childID uint64, characterIDs []uint64) (map[uint64]model.Progress, error)
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

// Upsert 按 (child_id, character_id) 唯一键写入 status：
// 不存在则创建，存在则更新 status/last_study_at/completed_at。返回最新记录。
// 注意：实现为查询+写入两步（FirstOrCreate），高并发同键写入依赖唯一约束兜底。
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

// TouchLastStudy 仅刷新 last_study_at（状态保持不变）。
// 用于状态机幂等分支：重复 start/complete 不改变状态、不改 completed_at，只更新学习时间。
func (r *progressRepository) TouchLastStudy(ctx context.Context, childID, characterID uint64) (*model.Progress, error) {
	now := time.Now()
	result := r.db.WithContext(ctx).Model(&model.Progress{}).
		Where("child_id = ? AND character_id = ?", childID, characterID).
		Updates(map[string]interface{}{
			"last_study_at": now,
			"updated_at":    now,
		})
	if result.Error != nil {
		return nil, result.Error
	}
	if result.RowsAffected == 0 {
		return nil, gorm.ErrRecordNotFound
	}
	return r.FindByChildAndCharacter(ctx, childID, characterID)
}

// GetStatsByChild 返回某儿童的学习进度统计。
// 注意：每次计数使用独立查询链，避免 gorm Where 条件在复用链上累积。
func (r *progressRepository) GetStatsByChild(ctx context.Context, childID uint64) (*ProgressStats, error) {
	var learned, learning int64

	if err := r.db.WithContext(ctx).Model(&model.Progress{}).
		Where("child_id = ? AND status = ?", childID, model.StatusLearned).
		Count(&learned).Error; err != nil {
		return nil, err
	}
	if err := r.db.WithContext(ctx).Model(&model.Progress{}).
		Where("child_id = ? AND status = ?", childID, model.StatusLearning).
		Count(&learning).Error; err != nil {
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

// ListByChildAndCharacterIDs 批量查询某儿童在指定汉字集合上的进度（单次 IN 查询）。
// 返回以 characterID 为键的映射；无进度的汉字不在映射中。
func (r *progressRepository) ListByChildAndCharacterIDs(ctx context.Context, childID uint64, characterIDs []uint64) (map[uint64]model.Progress, error) {
	result := make(map[uint64]model.Progress, len(characterIDs))
	if childID == 0 || len(characterIDs) == 0 {
		return result, nil
	}

	var rows []model.Progress
	if err := r.db.WithContext(ctx).
		Where("child_id = ? AND character_id IN ?", childID, characterIDs).
		Find(&rows).Error; err != nil {
		return nil, err
	}
	for _, p := range rows {
		result[p.CharacterID] = p
	}
	return result, nil
}
