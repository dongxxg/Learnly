package repository_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"learnly/backend/internal/model"
	"learnly/backend/internal/repository"
)

func TestCharacterRepository_ListOrder(t *testing.T) {
	db := newTestDB(t)
	repo := repository.NewCharacterRepository(db)
	ctx := context.Background()

	// 乱序插入：level/strokes 均与插入顺序不一致。
	seed := []model.Character{
		{Char: "我", Pinyin: "wǒ", Strokes: 7, Level: 2},
		{Char: "一", Pinyin: "yī", Strokes: 1, Level: 1},
		{Char: "十", Pinyin: "shí", Strokes: 2, Level: 1},
		{Char: "人", Pinyin: "rén", Strokes: 2, Level: 1},
		{Char: "三", Pinyin: "sān", Strokes: 3, Level: 1},
		{Char: "最", Pinyin: "zuì", Strokes: 12, Level: 3},
		{Char: "口", Pinyin: "kǒu", Strokes: 3, Level: 1},
	}
	for i := range seed {
		require.NoError(t, db.Create(&seed[i]).Error)
	}

	page, err := repo.List(ctx, 1, 10, 0)
	require.NoError(t, err)
	require.Len(t, page.Items, len(seed))

	// 期望顺序：level asc → strokes asc → id asc
	// （strokes 同为 2 时，十 id=3 先于人 id=4；strokes 同为 3 时，三 id=5 先于口 id=7）。
	want := []string{"一", "十", "人", "三", "口", "我", "最"}
	for i, w := range want {
		assert.Equal(t, w, page.Items[i].Char, "位置 %d", i)
	}
}

func TestCharacterRepository_ListOrderStableAcrossPages(t *testing.T) {
	db := newTestDB(t)
	repo := repository.NewCharacterRepository(db)
	ctx := context.Background()

	// 20 条 level/strokes 交叉数据，页大小 5。
	for i := 0; i < 20; i++ {
		c := model.Character{
			Char:    string(rune('a' + i)),
			Pinyin:  "p",
			Strokes: i%3 + 1,
			Level:   i%2 + 1,
		}
		require.NoError(t, db.Create(&c).Error)
	}

	p1, err := repo.List(ctx, 1, 5, 0)
	require.NoError(t, err)
	p2, err := repo.List(ctx, 2, 5, 0)
	require.NoError(t, err)
	require.Len(t, p1.Items, 5)
	require.Len(t, p2.Items, 5)

	// 前 10 条分页拼接结果必须与全量排序结果的前 10 条一致（无重叠、无遗漏、顺序稳定）。
	all, err := repo.List(ctx, 1, 100, 0)
	require.NoError(t, err)
	require.Len(t, all.Items, 20)

	var joined []uint64
	for _, it := range append(p1.Items, p2.Items...) {
		joined = append(joined, it.ID)
	}
	var wantIDs []uint64
	for _, it := range all.Items[:10] {
		wantIDs = append(wantIDs, it.ID)
	}
	assert.Equal(t, wantIDs, joined)
}

func TestCharacterRepository_FindByID(t *testing.T) {
	db := newTestDB(t)
	repo := repository.NewCharacterRepository(db)
	ctx := context.Background()

	_, err := repo.FindByID(ctx, 999)
	assert.Error(t, err)

	require.NoError(t, db.Create(&model.Character{Char: "一", Pinyin: "yī", Strokes: 1, Level: 1}).Error)
	c, err := repo.FindByID(ctx, 1)
	require.NoError(t, err)
	assert.Equal(t, "一", c.Char)
}

func TestCharacterRepository_CountByLevel(t *testing.T) {
	db := newTestDB(t)
	repo := repository.NewCharacterRepository(db)
	ctx := context.Background()

	require.NoError(t, db.Create(&model.Character{Char: "一", Pinyin: "yī", Strokes: 1, Level: 1}).Error)
	require.NoError(t, db.Create(&model.Character{Char: "大", Pinyin: "dà", Strokes: 3, Level: 2}).Error)

	n, err := repo.CountByLevel(ctx, 0)
	require.NoError(t, err)
	assert.Equal(t, int64(2), n) // level<=0 统计全部

	n, err = repo.CountByLevel(ctx, 2)
	require.NoError(t, err)
	assert.Equal(t, int64(1), n)
}

func TestCharacterRepository_ListLevelFilter(t *testing.T) {
	db := newTestDB(t)
	repo := repository.NewCharacterRepository(db)
	ctx := context.Background()

	require.NoError(t, db.Create(&model.Character{Char: "一", Pinyin: "yī", Strokes: 1, Level: 1}).Error)
	require.NoError(t, db.Create(&model.Character{Char: "大", Pinyin: "dà", Strokes: 3, Level: 2}).Error)

	page, err := repo.List(ctx, 1, 10, 2)
	require.NoError(t, err)
	assert.Equal(t, int64(1), page.Total)
	require.Len(t, page.Items, 1)
	assert.Equal(t, "大", page.Items[0].Char)
}
