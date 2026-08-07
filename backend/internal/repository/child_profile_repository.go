package repository

import (
	"context"

	"gorm.io/gorm"

	"learnly/backend/internal/model"
)

// ChildProfileRepository 儿童档案数据访问接口。
type ChildProfileRepository interface {
	FindByParentID(ctx context.Context, parentID uint64) ([]model.ChildProfile, error)
	FindByIDAndParent(ctx context.Context, id, parentID uint64) (*model.ChildProfile, error)
	Create(ctx context.Context, c *model.ChildProfile) error
}

type childProfileRepository struct {
	db *gorm.DB
}

// NewChildProfileRepository 构造 ChildProfileRepository。
func NewChildProfileRepository(db *gorm.DB) ChildProfileRepository {
	return &childProfileRepository{db: db}
}

// FindByParentID 列出某家长的全部儿童档案。
func (r *childProfileRepository) FindByParentID(ctx context.Context, parentID uint64) ([]model.ChildProfile, error) {
	var list []model.ChildProfile
	if err := r.db.WithContext(ctx).Where("parent_id = ?", parentID).Order("created_at asc").Find(&list).Error; err != nil {
		return nil, err
	}
	return list, nil
}

// FindByIDAndParent 按 ID 与家长 ID 查询，确保归属。
func (r *childProfileRepository) FindByIDAndParent(ctx context.Context, id, parentID uint64) (*model.ChildProfile, error) {
	var c model.ChildProfile
	if err := r.db.WithContext(ctx).Where("id = ? AND parent_id = ?", id, parentID).First(&c).Error; err != nil {
		return nil, err
	}
	return &c, nil
}

// Create 创建儿童档案。
func (r *childProfileRepository) Create(ctx context.Context, c *model.ChildProfile) error {
	return r.db.WithContext(ctx).Create(c).Error
}
