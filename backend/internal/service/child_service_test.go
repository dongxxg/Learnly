package service_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

	appauth "learnly/backend/internal/auth"
	"learnly/backend/internal/model"
	"learnly/backend/internal/repository"
	"learnly/backend/internal/service"
)

// mockChildRepoForService 仅覆写被测方法。
type mockChildRepoForService struct {
	repository.ChildProfileRepository
	findResult *model.ChildProfile
	findErr    error
	created    *model.ChildProfile
	createErr  error
}

func (m *mockChildRepoForService) FindByIDAndParent(ctx context.Context, id, parentID uint64) (*model.ChildProfile, error) {
	return m.findResult, m.findErr
}

func (m *mockChildRepoForService) Create(ctx context.Context, c *model.ChildProfile) error {
	m.created = c
	c.ID = 5
	return m.createErr
}

func TestChildService_CreateProfile(t *testing.T) {
	t.Run("成功创建并关联家长", func(t *testing.T) {
		repo := &mockChildRepoForService{}
		svc := service.NewChildService(repo)

		c, err := svc.CreateProfile(context.Background(), 1, "小明", "a.png")
		require.NoError(t, err)
		assert.Equal(t, "小明", c.Name)
		assert.Equal(t, uint64(1), c.ParentID)
		assert.Equal(t, uint64(5), c.ID)
	})

	t.Run("姓名为空拒绝", func(t *testing.T) {
		svc := service.NewChildService(&mockChildRepoForService{})
		_, err := svc.CreateProfile(context.Background(), 1, "", "")
		assert.ErrorContains(t, err, "姓名")
	})

	t.Run("仓储错误透传", func(t *testing.T) {
		repo := &mockChildRepoForService{createErr: assert.AnError}
		svc := service.NewChildService(repo)
		_, err := svc.CreateProfile(context.Background(), 1, "小明", "")
		assert.ErrorIs(t, err, assert.AnError)
	})
}

func TestChildService_SwitchProfile(t *testing.T) {
	t.Run("归属校验通过返回含 childId 的 JWT", func(t *testing.T) {
		repo := &mockChildRepoForService{findResult: &model.ChildProfile{ID: 6, ParentID: 1}}
		svc := service.NewChildService(repo)

		token, err := svc.SwitchProfile(context.Background(), 1, 6)
		require.NoError(t, err)
		require.NotEmpty(t, token)

		claims, err := appauth.VerifyToken(token)
		require.NoError(t, err)
		assert.Equal(t, uint64(1), claims.ParentID)
		assert.Equal(t, uint64(6), claims.ChildID)
	})

	t.Run("档案不存在或不属于当前家长拒绝", func(t *testing.T) {
		repo := &mockChildRepoForService{findErr: gorm.ErrRecordNotFound}
		svc := service.NewChildService(repo)

		_, err := svc.SwitchProfile(context.Background(), 1, 99)
		assert.ErrorContains(t, err, "不存在或不属于当前账号")
	})
}
