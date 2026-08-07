package service

import (
	"context"
	"errors"

	"learnly/backend/internal/model"
	"learnly/backend/internal/repository"
)

// CharacterService 汉字业务逻辑接口。
type CharacterService interface {
	GetByID(ctx context.Context, id uint64) (*model.Character, error)
	List(ctx context.Context, page, size, level int) (*repository.CharacterPage, error)
}

// characterService 实现 CharacterService。
type characterService struct {
	repo repository.CharacterRepository
}

// NewCharacterService 构造 CharacterService。
func NewCharacterService(repo repository.CharacterRepository) CharacterService {
	return &characterService{repo: repo}
}

// GetByID 查询单个汉字详情。
func (s *characterService) GetByID(ctx context.Context, id uint64) (*model.Character, error) {
	c, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return nil, errors.New("汉字不存在")
	}
	return c, nil
}

// List 分页/按 level 筛选查询汉字列表。
func (s *characterService) List(ctx context.Context, page, size, level int) (*repository.CharacterPage, error) {
	if page < 1 {
		page = 1
	}
	if size < 1 {
		size = 20
	}
	return s.repo.List(ctx, page, size, level)
}
