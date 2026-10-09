package service_test

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

	"learnly/backend/internal/model"
	"learnly/backend/internal/repository"
	"learnly/backend/internal/service"
)

// TestMain 注入测试 JWT 密钥（Register/Login/Switch 会签发真实 token）。
func TestMain(m *testing.M) {
	os.Setenv("JWT_SECRET", "test-secret")
	os.Exit(m.Run())
}

// mockProgressRepo 仅覆写被测方法；嵌入接口零值，误调未覆写方法会 panic 暴露问题。
type mockProgressRepo struct {
	repository.ProgressRepository

	findResult *model.Progress
	findErr    error

	upsertStatus string
	upsertCalls  int
	upsertResult *model.Progress

	touchCalls int
	touchErr   error

	gotChildID      uint64
	gotCharacterIDs []uint64
	batchResult     map[uint64]model.Progress
}

func (m *mockProgressRepo) FindByChildAndCharacter(ctx context.Context, childID, characterID uint64) (*model.Progress, error) {
	return m.findResult, m.findErr
}

func (m *mockProgressRepo) Upsert(ctx context.Context, childID, characterID uint64, status string) (*model.Progress, error) {
	m.upsertCalls++
	m.upsertStatus = status
	if m.upsertResult != nil {
		return m.upsertResult, nil
	}
	now := time.Now()
	return &model.Progress{ChildID: childID, CharacterID: characterID, Status: status, LastStudyAt: &now}, nil
}

func (m *mockProgressRepo) TouchLastStudy(ctx context.Context, childID, characterID uint64) (*model.Progress, error) {
	m.touchCalls++
	if m.touchErr != nil {
		return nil, m.touchErr
	}
	now := time.Now()
	// 模拟落库：返回状态不变、时间刷新的记录。
	status := model.StatusUnlearned
	lastStudy := &now
	if m.findResult != nil {
		status = m.findResult.Status
	}
	return &model.Progress{ChildID: childID, CharacterID: characterID, Status: status, LastStudyAt: lastStudy}, nil
}

func (m *mockProgressRepo) ListByChildAndCharacterIDs(ctx context.Context, childID uint64, characterIDs []uint64) (map[uint64]model.Progress, error) {
	m.gotChildID = childID
	m.gotCharacterIDs = characterIDs
	return m.batchResult, nil
}

func TestProgressService_RecordStudy_Validation(t *testing.T) {
	svc := service.NewProgressService(&mockProgressRepo{})
	ctx := context.Background()

	_, err := svc.RecordStudy(ctx, 0, 1, "start")
	assert.ErrorContains(t, err, "childId")

	_, err = svc.RecordStudy(ctx, 1, 0, "start")
	assert.ErrorContains(t, err, "characterId")

	_, err = svc.RecordStudy(ctx, 1, 1, "bad")
	assert.ErrorContains(t, err, "action")
}

func TestProgressService_RecordStudy_StartCreatesLearning(t *testing.T) {
	repo := &mockProgressRepo{findErr: gorm.ErrRecordNotFound}
	svc := service.NewProgressService(repo)

	p, err := svc.RecordStudy(context.Background(), 1, 10, "start")
	require.NoError(t, err)
	assert.Equal(t, model.StatusLearning, p.Status)
	assert.Equal(t, 1, repo.upsertCalls)
	assert.Equal(t, model.StatusLearning, repo.upsertStatus)
}

func TestProgressService_RecordStudy_StartOnLearningRefreshesOnly(t *testing.T) {
	old := time.Now().Add(-time.Hour)
	repo := &mockProgressRepo{findResult: &model.Progress{Status: model.StatusLearning, LastStudyAt: &old}}
	svc := service.NewProgressService(repo)

	p, err := svc.RecordStudy(context.Background(), 1, 10, "start")
	require.NoError(t, err)
	assert.Equal(t, model.StatusLearning, p.Status)
	assert.Equal(t, 0, repo.upsertCalls)     // 已在学不触发 upsert
	assert.Equal(t, 1, repo.touchCalls)      // 刷新学习时间必须落库
	assert.True(t, p.LastStudyAt.After(old)) // 返回刷新后的时间
}

func TestProgressService_RecordStudy_StartOnLearnedIgnored(t *testing.T) {
	old := time.Now().Add(-time.Hour)
	repo := &mockProgressRepo{findResult: &model.Progress{Status: model.StatusLearned, LastStudyAt: &old}}
	svc := service.NewProgressService(repo)

	p, err := svc.RecordStudy(context.Background(), 1, 10, "start")
	require.NoError(t, err)
	assert.Equal(t, model.StatusLearned, p.Status) // 已学不可回退
	assert.Equal(t, 0, repo.upsertCalls)
	assert.Equal(t, 1, repo.touchCalls)
	assert.True(t, p.LastStudyAt.After(old))
}

func TestProgressService_RecordStudy_CompleteCreatesLearned(t *testing.T) {
	repo := &mockProgressRepo{findErr: gorm.ErrRecordNotFound}
	svc := service.NewProgressService(repo)

	p, err := svc.RecordStudy(context.Background(), 1, 10, "complete")
	require.NoError(t, err)
	assert.Equal(t, model.StatusLearned, p.Status)
	assert.Equal(t, model.StatusLearned, repo.upsertStatus)
}

func TestProgressService_RecordStudy_CompleteOnLearning(t *testing.T) {
	repo := &mockProgressRepo{findResult: &model.Progress{Status: model.StatusLearning}}
	svc := service.NewProgressService(repo)

	p, err := svc.RecordStudy(context.Background(), 1, 10, "complete")
	require.NoError(t, err)
	assert.Equal(t, model.StatusLearned, p.Status)
	assert.Equal(t, 1, repo.upsertCalls)
	assert.Equal(t, model.StatusLearned, repo.upsertStatus)
}

func TestProgressService_RecordStudy_CompleteRepeatIdempotent(t *testing.T) {
	old := time.Now().Add(-time.Hour)
	repo := &mockProgressRepo{findResult: &model.Progress{Status: model.StatusLearned, LastStudyAt: &old}}
	svc := service.NewProgressService(repo)

	p, err := svc.RecordStudy(context.Background(), 1, 10, "complete")
	require.NoError(t, err)
	assert.Equal(t, model.StatusLearned, p.Status)
	assert.Equal(t, 0, repo.upsertCalls) // 重复完成不 upsert
	assert.Equal(t, 1, repo.touchCalls)  // 但学习时间刷新必须落库
	assert.True(t, p.LastStudyAt.After(old))
}

func TestProgressService_RecordStudy_RepoErrorNotSwallowed(t *testing.T) {
	// 非"记录不存在"的查询错误必须上抛，不得当作首次学习处理。
	repo := &mockProgressRepo{findErr: assert.AnError}
	svc := service.NewProgressService(repo)

	_, err := svc.RecordStudy(context.Background(), 1, 10, "start")
	assert.ErrorIs(t, err, assert.AnError)
	assert.Equal(t, 0, repo.upsertCalls)
	assert.Equal(t, 0, repo.touchCalls)
}

func TestProgressService_GetStatusesByCharacters(t *testing.T) {
	repo := &mockProgressRepo{
		batchResult: map[uint64]model.Progress{
			10: {CharacterID: 10, Status: model.StatusLearned},
			20: {CharacterID: 20, Status: model.StatusLearning},
		},
	}
	svc := service.NewProgressService(repo)

	got, err := svc.GetStatusesByCharacters(context.Background(), 7, []uint64{10, 20, 30})
	require.NoError(t, err)
	assert.Len(t, got, 2)
	assert.Equal(t, model.StatusLearned, got[10].Status)
	assert.Equal(t, model.StatusLearning, got[20].Status)
	_, ok := got[30] // 无进度的汉字不在映射中
	assert.False(t, ok)

	// 参数透传正确。
	assert.Equal(t, uint64(7), repo.gotChildID)
	assert.Equal(t, []uint64{10, 20, 30}, repo.gotCharacterIDs)
}
