package service

import (
	"context"
	"errors"
	"time"

	appauth "learnly/backend/internal/auth"
	"learnly/backend/internal/model"
	"learnly/backend/internal/repository"
)

// ChildService 儿童档案业务逻辑接口。
type ChildService interface {
	CreateProfile(ctx context.Context, parentID uint64, name, avatar string) (*model.ChildProfile, error)
	SwitchProfile(ctx context.Context, parentID, childID uint64) (string, error)
}

// childService 实现 ChildService。
type childService struct {
	childRepo   repository.ChildProfileRepository
	tokenExpire time.Duration
}

// NewChildService 构造 ChildService。
func NewChildService(childRepo repository.ChildProfileRepository) ChildService {
	return &childService{
		childRepo:   childRepo,
		tokenExpire: 72 * time.Hour,
	}
}

// CreateProfile 为当前家长创建儿童档案。
func (s *childService) CreateProfile(ctx context.Context, parentID uint64, name, avatar string) (*model.ChildProfile, error) {
	if name == "" {
		return nil, errors.New("儿童姓名不能为空")
	}
	c := &model.ChildProfile{
		ParentID: parentID,
		Name:     name,
		Avatar:   avatar,
	}
	if err := s.childRepo.Create(ctx, c); err != nil {
		return nil, err
	}
	return c, nil
}

// SwitchProfile 切换当前儿童。校验 childId 属于当前 parent，返回新 JWT（含 childId 声明）。
func (s *childService) SwitchProfile(ctx context.Context, parentID, childID uint64) (string, error) {
	c, err := s.childRepo.FindByIDAndParent(ctx, childID, parentID)
	if err != nil {
		return "", errors.New("儿童档案不存在或不属于当前账号")
	}
	return appauth.GenerateToken(parentID, c.ID, s.tokenExpire)
}
