package service

import (
	"context"
	"errors"
	"time"

	"learnly/backend/internal/model"
	"learnly/backend/internal/repository"
)

// ProgressService 学习进度业务逻辑接口。
type ProgressService interface {
	RecordStudy(ctx context.Context, childID, characterID uint64, action string) (*model.Progress, error)
	GetStats(ctx context.Context, childID uint64) (*repository.ProgressStats, error)
	GetStatusByCharacter(ctx context.Context, childID, characterID uint64) (*model.Progress, error)
}

// progressService 实现 ProgressService。
type progressService struct {
	progressRepo repository.ProgressRepository
}

// NewProgressService 构造 ProgressService。
func NewProgressService(progressRepo repository.ProgressRepository) ProgressService {
	return &progressService{progressRepo: progressRepo}
}

// RecordStudy 记录学习行为。
// 状态机：未学(unlearned) → 在学(learning) → 已学(learned)，单向不可逆。
// action: "start" | "complete"。重复完成仅更新 last_study_at。
func (s *progressService) RecordStudy(ctx context.Context, childID, characterID uint64, action string) (*model.Progress, error) {
	if childID == 0 || characterID == 0 {
		return nil, errors.New("childId 与 characterId 必填")
	}
	if action != "start" && action != "complete" {
		return nil, errors.New("action 必须为 start 或 complete")
	}

	now := time.Now()

	// 查询现有进度（可能不存在）。
	existing, err := s.progressRepo.FindByChildAndCharacter(ctx, childID, characterID)
	if err != nil {
		// 不存在则按 action 创建新记录。
		return s.progressRepo.Upsert(ctx, childID, characterID, statusForAction(action))
	}

	// 状态机校验：单向不可逆。
	switch action {
	case "start":
		// 已学状态忽略 start；未学/在学状态转为在学。
		if existing.Status == model.StatusLearned {
			// 已学不可回退，仅更新 last_study_at。
			existing.LastStudyAt = &now
			return existing, nil
		}
		if existing.Status == model.StatusLearning {
			// 已在学，仅更新时间。
			existing.LastStudyAt = &now
			return existing, nil
		}
		// unlearned → learning
		return s.progressRepo.Upsert(ctx, childID, characterID, model.StatusLearning)

	case "complete":
		if existing.Status == model.StatusLearned {
			// 重复完成：保持已学，更新 last_study_at。
			existing.LastStudyAt = &now
			return existing, nil
		}
		// learning/unlearned → learned
		return s.progressRepo.Upsert(ctx, childID, characterID, model.StatusLearned)
	}

	return nil, errors.New("未知 action")
}

// statusForAction 首次创建时根据 action 决定初始状态。
func statusForAction(action string) string {
	if action == "complete" {
		return model.StatusLearned
	}
	return model.StatusLearning
}

// GetStats 返回当前儿童的学习统计。
func (s *progressService) GetStats(ctx context.Context, childID uint64) (*repository.ProgressStats, error) {
	return s.progressRepo.GetStatsByChild(ctx, childID)
}

// GetStatusByCharacter 返回某儿童某汉字的进度。
func (s *progressService) GetStatusByCharacter(ctx context.Context, childID, characterID uint64) (*model.Progress, error) {
	p, err := s.progressRepo.FindByChildAndCharacter(ctx, childID, characterID)
	if err != nil {
		return nil, err
	}
	return p, nil
}
