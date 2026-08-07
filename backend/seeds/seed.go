package seeds

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"learnly/backend/internal/model"
)

// CharacterSeed 汉字种子数据。
type CharacterSeed struct {
	Char       string `json:"char"`
	Pinyin     string `json:"pinyin"`
	Strokes    int    `json:"strokes"`
	Level      int    `json:"level"`
	Definition string `json:"definition"`
}

// SeedResult 加载结果统计。
type SeedResult struct {
	Inserted int
	Skipped  int
	Total    int
}

// getSeedPath 解析种子 JSON 文件路径。
// 优先环境变量 SEED_PATH，其次按可执行文件相对路径定位。
func getSeedPath() string {
	if p := os.Getenv("SEED_PATH"); p != "" {
		return p
	}
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		return "seeds/characters.json"
	}
	return filepath.Join(filepath.Dir(filename), "characters.json")
}

// LoadCharacters 读取种子 JSON 并幂等写入 characters 表。
// 按 char 唯一键 MERGE：已存在则跳过，不存在则插入。
func LoadCharacters(db *gorm.DB, path string) (*SeedResult, error) {
	if path == "" {
		path = getSeedPath()
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read seed file %s: %w", path, err)
	}

	var seeds []CharacterSeed
	if err := json.Unmarshal(data, &seeds); err != nil {
		return nil, fmt.Errorf("parse seed json: %w", err)
	}

	if len(seeds) == 0 {
		return nil, fmt.Errorf("seed file is empty")
	}

	result := &SeedResult{Total: len(seeds)}
	now := time.Now()

	for _, s := range seeds {
		c := model.Character{
			Char:       s.Char,
			Pinyin:     s.Pinyin,
			Strokes:    s.Strokes,
			Level:      s.Level,
			Definition: s.Definition,
			OrderData:  "",
			CreatedAt:  now,
		}
		// 冲突时（char 已存在）不做任何操作，利用 RETURNING 统计实际插入。
		res := db.Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "char"}},
			DoNothing: true,
		}).Create(&c)

		if res.Error != nil {
			return nil, fmt.Errorf("upsert character %s: %w", s.Char, res.Error)
		}
		if res.RowsAffected > 0 {
			result.Inserted++
		} else {
			result.Skipped++
		}
	}

	return result, nil
}
