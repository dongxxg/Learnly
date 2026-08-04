package config

import (
	"fmt"

	"github.com/spf13/viper"
)

// Config 聚合所有子配置。环境变量前缀 LEARNLY_，例：LEARNLY_POSTGRES_HOST。
type Config struct {
	Server   ServerConfig
	Postgres PostgresConfig
	Redis    RedisConfig
	AI       AIConfig
	JWT      JWTConfig
}

type ServerConfig struct {
	Port string
	Mode string // debug | release | test
}

type PostgresConfig struct {
	Host     string
	Port     string
	User     string
	Password string
	DBName   string
	SSLMode  string
}

func (p PostgresConfig) DSN() string {
	return fmt.Sprintf(
		"host=%s port=%s user=%s password=%s dbname=%s sslmode=%s TimeZone=Asia/Shanghai",
		p.Host, p.Port, p.User, p.Password, p.DBName, p.SSLMode,
	)
}

type RedisConfig struct {
	Host     string
	Port     string
	Password string
	DB       int
}

type AIConfig struct {
	BaseURL string // ai-service 内部地址，用于 AI 老师等请求转发
}

type JWTConfig struct {
	Secret      string
	ExpireHours int
}

func Load() (*Config, error) {
	v := viper.New()
	v.SetEnvPrefix("LEARNLY")
	v.AutomaticEnv()

	v.SetDefault("SERVER_PORT", "8080")
	v.SetDefault("SERVER_MODE", "debug")
	v.SetDefault("POSTGRES_HOST", "localhost")
	v.SetDefault("POSTGRES_PORT", "5432")
	v.SetDefault("POSTGRES_SSLMODE", "disable")
	v.SetDefault("REDIS_HOST", "localhost")
	v.SetDefault("REDIS_PORT", "6379")
	v.SetDefault("REDIS_DB", 0)
	v.SetDefault("AI_BASEURL", "http://ai-service:8000")
	v.SetDefault("JWT_EXPIRE_HOURS", 24)

	return &Config{
		Server: ServerConfig{
			Port: v.GetString("server_port"),
			Mode: v.GetString("server_mode"),
		},
		Postgres: PostgresConfig{
			Host:     v.GetString("postgres_host"),
			Port:     v.GetString("postgres_port"),
			User:     v.GetString("postgres_user"),
			Password: v.GetString("postgres_password"),
			DBName:   v.GetString("postgres_dbname"),
			SSLMode:  v.GetString("postgres_sslmode"),
		},
		Redis: RedisConfig{
			Host:     v.GetString("redis_host"),
			Port:     v.GetString("redis_port"),
			Password: v.GetString("redis_password"),
			DB:       v.GetInt("redis_db"),
		},
		AI: AIConfig{BaseURL: v.GetString("ai_baseurl")},
		JWT: JWTConfig{
			Secret:      v.GetString("jwt_secret"),
			ExpireHours: v.GetInt("jwt_expire_hours"),
		},
	}, nil
}
