package store

import (
	"fmt"
	"log"

	"gorm.io/gorm"

	"learnly/backend/internal/model"
)

// AutoMigrate 按顺序创建所有业务表。
// 失败返回错误，由调用方决定是否阻塞启动。
func AutoMigrate(db *gorm.DB) error {
	if db == nil {
		return fmt.Errorf("db is nil, skip migration")
	}
	if err := db.AutoMigrate(model.AllModels()...); err != nil {
		return fmt.Errorf("auto migrate: %w", err)
	}
	log.Printf("[migration] migrated %d tables", len(model.AllModels()))
	return nil
}
