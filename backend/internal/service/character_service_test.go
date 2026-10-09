package service_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

	"learnly/backend/internal/model"
	"learnly/backend/internal/repository"
	"learnly/backend/internal/service"
)

// mockCharacterRepo 仅覆写被测方法。
type mockCharacterRepo struct {
	repository.CharacterRepository
	findResult *model.Character
	findErr    error

	gotPage, gotSize, gotLevel int
	pageResult                 *repository.CharacterPage
}

func (m *mockCharacterRepo) FindByID(ctx context.Context, id uint64) (*model.Character, error) {
	return m.findResult, m.findErr
}

func (m *mockCharacterRepo) List(ctx context.Context, page, size, level int) (*repository.CharacterPage, error) {
	m.gotPage, m.gotSize, m.gotLevel = page, size, level
	return m.pageResult, nil
}

func TestCharacterService_GetByID_Found(t *testing.T) {
	repo := &mockCharacterRepo{findResult: &model.Character{ID: 1, Char: "一", Pinyin: "yī"}}
	svc := service.NewCharacterService(repo)

	c, err := svc.GetByID(context.Background(), 1)
	require.NoError(t, err)
	assert.Equal(t, "一", c.Char)
}

func TestCharacterService_GetByID_NotFound(t *testing.T) {
	repo := &mockCharacterRepo{findErr: gorm.ErrRecordNotFound}
	svc := service.NewCharacterService(repo)

	_, err := svc.GetByID(context.Background(), 999)
	assert.ErrorContains(t, err, "不存在")
}

func TestCharacterService_List_ClampsParams(t *testing.T) {
	repo := &mockCharacterRepo{pageResult: &repository.CharacterPage{}}
	svc := service.NewCharacterService(repo)

	_, err := svc.List(context.Background(), 0, 0, 2)
	require.NoError(t, err)
	assert.Equal(t, 1, repo.gotPage)  // page<1 归一为 1
	assert.Equal(t, 20, repo.gotSize) // size<1 归一为 20
	assert.Equal(t, 2, repo.gotLevel) // level 透传
}
