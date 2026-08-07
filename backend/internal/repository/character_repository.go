package repository

import (
	"context"

	"gorm.io/gorm"

	"learnly/backend/internal/model"
)

// CharacterPage 汉字分页查询结果。
type CharacterPage struct {
	Total int64
	Page  int
	Size  int
	Items []model.Character
}

// CharacterRepository 汉字数据访问接口。
type CharacterRepository interface {
	FindByID(ctx context.Context, id uint64) (*model.Character, error)
	List(ctx context.Context, page, size, level int) (*CharacterPage, error)
	CountByLevel(ctx context.Context, level int) (int64, error)
}

type characterRepository struct {
	db *gorm.DB
}

// NewCharacterRepository 构造 CharacterRepository。
func NewCharacterRepository(db *gorm.DB) CharacterRepository {
	return &characterRepository{db: db}
}

// FindByID 按主键查询汉字。
func (r *characterRepository) FindByID(ctx context.Context, id uint64) (*model.Character, error) {
	var c model.Character
	if err := r.db.WithContext(ctx).First(&c, id).Error; err != nil {
		return nil, err
	}
	return &c, nil
}

// List 分页/按 level 筛选查询汉字。
func (r *characterRepository) List(ctx context.Context, page, size, level int) (*CharacterPage, error) {
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 100 {
		size = 20
	}

	tx := r.db.WithContext(ctx).Model(&model.Character{})
	if level > 0 {
		tx = tx.Where("level = ?", level)
	}

	var total int64
	if err := tx.Count(&total).Error; err != nil {
		return nil, err
	}

	var items []model.Character
	if err := tx.Order("id asc").Offset((page - 1) * size).Limit(size).Find(&items).Error; err != nil {
		return nil, err
	}

	return &CharacterPage{
		Total: total,
		Page:  page,
		Size:  size,
		Items: items,
	}, nil
}

// CountByLevel 统计某等级（或全部，level<=0）汉字数。
func (r *characterRepository) CountByLevel(ctx context.Context, level int) (int64, error) {
	tx := r.db.WithContext(ctx).Model(&model.Character{})
	if level > 0 {
		tx = tx.Where("level = ?", level)
	}
	var n int64
	if err := tx.Count(&n).Error; err != nil {
		return 0, err
	}
	return n, nil
}
