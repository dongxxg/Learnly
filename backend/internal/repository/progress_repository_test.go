package repository_test

import (
	"context"
	"testing"
	"time"

	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

	"learnly/backend/internal/model"
	"learnly/backend/internal/repository"
)

// newTestDB 创建 sqlite 内存库并迁移。
func newTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(model.AllModels()...))
	return db
}

func TestProgressRepository_Upsert(t *testing.T) {
	db := newTestDB(t)
	repo := repository.NewProgressRepository(db)
	ctx := context.Background()

	// 首次 upsert 创建记录。
	p, err := repo.Upsert(ctx, 1, 100, model.StatusLearning)
	require.NoError(t, err)
	assert.Equal(t, model.StatusLearning, p.Status)
	assert.NotNil(t, p.LastStudyAt)

	// 再次 upsert 更新状态（learning → learned）。
	p2, err := repo.Upsert(ctx, 1, 100, model.StatusLearned)
	require.NoError(t, err)
	assert.Equal(t, model.StatusLearned, p2.Status)
	assert.NotNil(t, p2.CompletedAt)
	assert.Equal(t, p.ID, p2.ID) // 同一条记录
}

func TestProgressRepository_FindByChildAndCharacter(t *testing.T) {
	db := newTestDB(t)
	repo := repository.NewProgressRepository(db)
	ctx := context.Background()

	// 不存在。
	_, err := repo.FindByChildAndCharacter(ctx, 1, 100)
	assert.ErrorIs(t, err, gorm.ErrRecordNotFound)

	// 创建后查询。
	_, err = repo.Upsert(ctx, 1, 100, model.StatusLearned)
	require.NoError(t, err)

	p, err := repo.FindByChildAndCharacter(ctx, 1, 100)
	require.NoError(t, err)
	assert.Equal(t, uint64(100), p.CharacterID)
	assert.Equal(t, model.StatusLearned, p.Status)
}

func TestProgressRepository_GetStatsByChild(t *testing.T) {
	db := newTestDB(t)
	repo := repository.NewProgressRepository(db)
	charRepo := repository.NewCharacterRepository(db)
	ctx := context.Background()

	// 预置字符。
	require.NoError(t, db.Create(&model.Character{Char: "一", Pinyin: "yī", Strokes: 1, Level: 1}).Error)
	require.NoError(t, db.Create(&model.Character{Char: "二", Pinyin: "èr", Strokes: 2, Level: 1}).Error)
	require.NoError(t, db.Create(&model.Character{Char: "三", Pinyin: "sān", Strokes: 3, Level: 1}).Error)
	_ = charRepo

	// 创建进度。
	_, err := repo.Upsert(ctx, 1, 1, model.StatusLearned) // 一
	require.NoError(t, err)
	_, err = repo.Upsert(ctx, 1, 2, model.StatusLearning) // 二
	require.NoError(t, err)

	stats, err := repo.GetStatsByChild(ctx, 1)
	require.NoError(t, err)
	assert.Equal(t, int64(1), stats.Learned)
	assert.Equal(t, int64(1), stats.Learning)
	assert.Equal(t, int64(1), stats.Unlearned) // 3 total - 2 = 1
	assert.Equal(t, int64(3), stats.Total)
}

func TestProgressRepository_StatsEmpty(t *testing.T) {
	db := newTestDB(t)
	repo := repository.NewProgressRepository(db)
	ctx := context.Background()

	// 无字符无进度。
	stats, err := repo.GetStatsByChild(ctx, 1)
	require.NoError(t, err)
	assert.Equal(t, int64(0), stats.Total)
	assert.Equal(t, int64(0), stats.Learned)
	assert.Equal(t, int64(0), stats.Learning)
	assert.Equal(t, int64(0), stats.Unlearned)
}

func TestProgressRepository_TouchLastStudy(t *testing.T) {
	db := newTestDB(t)
	repo := repository.NewProgressRepository(db)
	ctx := context.Background()

	// 不存在时返回 NotFound。
	_, err := repo.TouchLastStudy(ctx, 1, 100)
	assert.ErrorIs(t, err, gorm.ErrRecordNotFound)

	// 建档（completed_at 固定），再 touch。
	_, err = repo.Upsert(ctx, 1, 100, model.StatusLearned)
	require.NoError(t, err)
	before, err := repo.FindByChildAndCharacter(ctx, 1, 100)
	require.NoError(t, err)

	time.Sleep(10 * time.Millisecond) // 保证时间戳可比较
	p, err := repo.TouchLastStudy(ctx, 1, 100)
	require.NoError(t, err)
	assert.Equal(t, model.StatusLearned, p.Status)           // 状态保持
	assert.True(t, p.LastStudyAt.After(*before.LastStudyAt)) // 学习时间刷新
	assert.Equal(t, before.CompletedAt, p.CompletedAt)       // completed_at 不被改写
}

func TestProgressRepository_CountByChild(t *testing.T) {
	db := newTestDB(t)
	repo := repository.NewProgressRepository(db)
	ctx := context.Background()

	n, err := repo.CountByChild(ctx, 1)
	require.NoError(t, err)
	assert.Equal(t, int64(0), n)

	_, err = repo.Upsert(ctx, 1, 100, model.StatusLearning)
	require.NoError(t, err)
	_, err = repo.Upsert(ctx, 1, 101, model.StatusLearned)
	require.NoError(t, err)

	n, err = repo.CountByChild(ctx, 1)
	require.NoError(t, err)
	assert.Equal(t, int64(2), n)
}

func TestProgressRepository_ListByChildAndCharacterIDs(t *testing.T) {
	db := newTestDB(t)
	repo := repository.NewProgressRepository(db)
	ctx := context.Background()

	// 预置 3 个字符，其中 2 个有进度。
	require.NoError(t, db.Create(&model.Character{Char: "一", Pinyin: "yī", Strokes: 1, Level: 1}).Error)
	require.NoError(t, db.Create(&model.Character{Char: "二", Pinyin: "èr", Strokes: 2, Level: 1}).Error)
	require.NoError(t, db.Create(&model.Character{Char: "三", Pinyin: "sān", Strokes: 3, Level: 1}).Error)
	_, err := repo.Upsert(ctx, 1, 1, model.StatusLearned)
	require.NoError(t, err)
	_, err = repo.Upsert(ctx, 1, 2, model.StatusLearning)
	require.NoError(t, err)

	// 批量查询 3 个字：仅返回有进度的 2 个，键为 characterID。
	got, err := repo.ListByChildAndCharacterIDs(ctx, 1, []uint64{1, 2, 3})
	require.NoError(t, err)
	assert.Len(t, got, 2)
	assert.Equal(t, model.StatusLearned, got[1].Status)
	assert.Equal(t, model.StatusLearning, got[2].Status)

	// 其他 child 的进度不串。
	got2, err := repo.ListByChildAndCharacterIDs(ctx, 9, []uint64{1, 2, 3})
	require.NoError(t, err)
	assert.Empty(t, got2)

	// 空入参安全返回空映射。
	got3, err := repo.ListByChildAndCharacterIDs(ctx, 1, nil)
	require.NoError(t, err)
	assert.Empty(t, got3)
}

var _ = time.Now
