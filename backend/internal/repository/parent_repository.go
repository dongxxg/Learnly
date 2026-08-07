package repository

import (
	"context"

	"gorm.io/gorm"

	"learnly/backend/internal/model"
)

// ParentRepository 家长数据访问接口。
type ParentRepository interface {
	FindByPhone(ctx context.Context, phone string) (*model.Parent, error)
	Create(ctx context.Context, p *model.Parent) error
}

// parentRepository 基于 GORM 的 ParentRepository 实现。
type parentRepository struct {
	db *gorm.DB
}

// NewParentRepository 构造 ParentRepository。
func NewParentRepository(db *gorm.DB) ParentRepository {
	return &parentRepository{db: db}
}

// FindByPhone 按手机号查询家长。未找到返回 gorm.ErrRecordNotFound。
func (r *parentRepository) FindByPhone(ctx context.Context, phone string) (*model.Parent, error) {
	var p model.Parent
	if err := r.db.WithContext(ctx).Where("phone = ?", phone).First(&p).Error; err != nil {
		return nil, err
	}
	return &p, nil
}

// Create 创建家长记录。
func (r *parentRepository) Create(ctx context.Context, p *model.Parent) error {
	return r.db.WithContext(ctx).Create(p).Error
}
