package repository_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

	"learnly/backend/internal/model"
	"learnly/backend/internal/repository"
)

func TestParentRepository_FindByPhone(t *testing.T) {
	db := newTestDB(t)
	repo := repository.NewParentRepository(db)
	ctx := context.Background()

	// 不存在。
	_, err := repo.FindByPhone(ctx, "13800138000")
	assert.ErrorIs(t, err, gorm.ErrRecordNotFound)

	// 创建后可查。
	require.NoError(t, db.Create(&model.Parent{Phone: "13800138000", PasswordHash: "h"}).Error)
	p, err := repo.FindByPhone(ctx, "13800138000")
	require.NoError(t, err)
	assert.Equal(t, "13800138000", p.Phone)
}

func TestParentRepository_Create(t *testing.T) {
	db := newTestDB(t)
	repo := repository.NewParentRepository(db)
	ctx := context.Background()

	p := &model.Parent{Phone: "13900139000", PasswordHash: "h"}
	require.NoError(t, repo.Create(ctx, p))
	assert.Positive(t, p.ID)

	// 手机号唯一约束。
	dup := &model.Parent{Phone: "13900139000", PasswordHash: "h"}
	assert.Error(t, repo.Create(ctx, dup))
}

func TestChildProfileRepository_CreateAndFindByParentID(t *testing.T) {
	db := newTestDB(t)
	repo := repository.NewChildProfileRepository(db)
	ctx := context.Background()

	require.NoError(t, repo.Create(ctx, &model.ChildProfile{ParentID: 1, Name: "小明"}))
	require.NoError(t, repo.Create(ctx, &model.ChildProfile{ParentID: 1, Name: "小红"}))
	require.NoError(t, repo.Create(ctx, &model.ChildProfile{ParentID: 2, Name: "别人家的"}))

	children, err := repo.FindByParentID(ctx, 1)
	require.NoError(t, err)
	require.Len(t, children, 2) // 只返回当前家长的档案
}

func TestChildProfileRepository_FindByIDAndParent(t *testing.T) {
	db := newTestDB(t)
	repo := repository.NewChildProfileRepository(db)
	ctx := context.Background()

	require.NoError(t, repo.Create(ctx, &model.ChildProfile{ParentID: 1, Name: "小明"}))

	// 归属正确可查。
	c, err := repo.FindByIDAndParent(ctx, 1, 1)
	require.NoError(t, err)
	assert.Equal(t, "小明", c.Name)

	// 归属不匹配不可查（越权防护）。
	_, err = repo.FindByIDAndParent(ctx, 1, 999)
	assert.ErrorIs(t, err, gorm.ErrRecordNotFound)
}
