package store

import (
	"log"
	"time"

	"github.com/redis/go-redis/v9"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"

	"learnly/backend/internal/config"
)

// NewPostgres 初始化 GORM 连接。连接失败只告警不致命——
// 保证容器在 postgres 未就绪时仍可启动（配合 docker-compose 启动顺序与就绪探针）。
func NewPostgres(cfg config.PostgresConfig) *gorm.DB {
	db, err := gorm.Open(postgres.Open(cfg.DSN()), &gorm.Config{})
	if err != nil {
		log.Printf("[warn] postgres connect failed (will retry via readiness probe): %v", err)
		return nil
	}
	sqlDB, err := db.DB()
	if err != nil {
		log.Printf("[warn] postgres raw db handle: %v", err)
		return db
	}
	sqlDB.SetMaxIdleConns(10)
	sqlDB.SetMaxOpenConns(100)
	sqlDB.SetConnMaxLifetime(time.Hour)
	return db
}

// NewRedis 构造 redis 客户端，连接由调用方按需 Ping。
func NewRedis(cfg config.RedisConfig) *redis.Client {
	return redis.NewClient(&redis.Options{
		Addr:     cfg.Host + ":" + cfg.Port,
		Password: cfg.Password,
		DB:       cfg.DB,
	})
}
