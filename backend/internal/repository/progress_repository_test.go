package repository_test

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/sqlite"
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

var _ = time.Now
