package service_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"

	"learnly/backend/internal/model"
	"learnly/backend/internal/repository"
	"learnly/backend/internal/service"
)

// mockParentRepo 仅覆写被测方法。
type mockParentRepo struct {
	repository.ParentRepository
	findResult *model.Parent
	findErr    error
	created    *model.Parent
	createErr  error
}

func (m *mockParentRepo) FindByPhone(ctx context.Context, phone string) (*model.Parent, error) {
	return m.findResult, m.findErr
}

func (m *mockParentRepo) Create(ctx context.Context, p *model.Parent) error {
	m.created = p
	p.ID = 42
	return m.createErr
}

// mockChildRepo 仅覆写 FindByParentID。
type mockChildRepo struct {
	repository.ChildProfileRepository
	children []model.ChildProfile
}

func (m *mockChildRepo) FindByParentID(ctx context.Context, parentID uint64) ([]model.ChildProfile, error) {
	return m.children, nil
}

func TestAuthService_Register_Validation(t *testing.T) {
	svc := service.NewAuthService(&mockParentRepo{}, &mockChildRepo{})
	ctx := context.Background()

	_, err := svc.Register(ctx, "", "123456")
	assert.ErrorContains(t, err, "手机号")

	_, err = svc.Register(ctx, "13800138000", "")
	assert.ErrorContains(t, err, "密码")

	_, err = svc.Register(ctx, "13800138000", "12345")
	assert.ErrorContains(t, err, "6 位")
}

func TestAuthService_Register_PhoneExists(t *testing.T) {
	repo := &mockParentRepo{findResult: &model.Parent{ID: 1, Phone: "13800138000"}}
	svc := service.NewAuthService(repo, &mockChildRepo{})

	_, err := svc.Register(context.Background(), "13800138000", "123456")
	assert.ErrorContains(t, err, "已注册")
	assert.Nil(t, repo.created) // 未创建新记录
}

func TestAuthService_Register_Success(t *testing.T) {
	repo := &mockParentRepo{findErr: gorm.ErrRecordNotFound}
	svc := service.NewAuthService(repo, &mockChildRepo{})

	result, err := svc.Register(context.Background(), "13800138000", "123456")
	require.NoError(t, err)
	assert.NotEmpty(t, result.Token)
	assert.Equal(t, uint64(42), result.ParentID)
	assert.Positive(t, result.ExpiresIn)
	assert.Empty(t, result.Children)

	// 密码以 bcrypt 哈希存储，可验证不可逆读。
	require.NotNil(t, repo.created)
	assert.NotEqual(t, "123456", repo.created.PasswordHash)
	assert.NoError(t, bcrypt.CompareHashAndPassword([]byte(repo.created.PasswordHash), []byte("123456")))
}

func TestAuthService_Register_RepoErrorPropagates(t *testing.T) {
	repo := &mockParentRepo{findErr: gorm.ErrRecordNotFound, createErr: assert.AnError}
	svc := service.NewAuthService(repo, &mockChildRepo{})

	_, err := svc.Register(context.Background(), "13800138000", "123456")
	assert.ErrorIs(t, err, assert.AnError)
}

func TestAuthService_Login_Validation(t *testing.T) {
	svc := service.NewAuthService(&mockParentRepo{}, &mockChildRepo{})
	ctx := context.Background()

	_, err := svc.Login(ctx, "", "123456")
	assert.ErrorContains(t, err, "手机号")

	_, err = svc.Login(ctx, "13800138000", "")
	assert.ErrorContains(t, err, "密码")
}

func TestAuthService_Login_PhoneNotFound(t *testing.T) {
	repo := &mockParentRepo{findErr: gorm.ErrRecordNotFound}
	svc := service.NewAuthService(repo, &mockChildRepo{})

	_, err := svc.Login(context.Background(), "13800138000", "123456")
	assert.ErrorContains(t, err, "手机号或密码错误")
}

func TestAuthService_Login_WrongPassword(t *testing.T) {
	hash, err := bcrypt.GenerateFromPassword([]byte("123456"), bcrypt.MinCost)
	require.NoError(t, err)
	repo := &mockParentRepo{findResult: &model.Parent{ID: 1, Phone: "13800138000", PasswordHash: string(hash)}}
	svc := service.NewAuthService(repo, &mockChildRepo{})

	_, err = svc.Login(context.Background(), "13800138000", "wrong-password")
	assert.ErrorContains(t, err, "手机号或密码错误")
}

func TestAuthService_Login_Success(t *testing.T) {
	hash, err := bcrypt.GenerateFromPassword([]byte("123456"), bcrypt.MinCost)
	require.NoError(t, err)
	repo := &mockParentRepo{findResult: &model.Parent{ID: 1, Phone: "13800138000", PasswordHash: string(hash)}}
	childRepo := &mockChildRepo{children: []model.ChildProfile{
		{ID: 5, Name: "小明", Avatar: "a.png"},
		{ID: 6, Name: "小红"},
	}}
	svc := service.NewAuthService(repo, childRepo)

	result, err := svc.Login(context.Background(), "13800138000", "123456")
	require.NoError(t, err)
	assert.NotEmpty(t, result.Token)
	assert.Equal(t, uint64(1), result.ParentID)
	require.Len(t, result.Children, 2)
	assert.Equal(t, uint64(5), result.Children[0].ID)
	assert.Equal(t, "小明", result.Children[0].Name)
	assert.Equal(t, "a.png", result.Children[0].Avatar)
}
