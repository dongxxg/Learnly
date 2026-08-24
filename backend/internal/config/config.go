package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	pkgconfig "github.com/dongxxg/go-tools/config"
)

// Config 聚合所有子配置。环境变量名为配置键大写、点号换下划线，例：POSTGRES_HOST、JWT_SECRET。
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

// 配置文件名，与 pkg/config 的默认约定一致。
const configFileName = "configuration.toml"

// Load 加载配置。底层由 pkg/config 读取 configuration.toml，
// 环境变量优先于文件值；jwt.secret 为空时报错，必须由环境变量或文件提供。
func Load() (*Config, error) {
	if err := ensureLoaded(); err != nil {
		return nil, err
	}

	cfg := &Config{
		Server: ServerConfig{
			Port: pkgconfig.GetString("server.port"),
			Mode: pkgconfig.GetString("server.mode"),
		},
		Postgres: PostgresConfig{
			Host:     pkgconfig.GetString("postgres.host"),
			Port:     pkgconfig.GetString("postgres.port"),
			User:     pkgconfig.GetString("postgres.user"),
			Password: pkgconfig.GetString("postgres.password"),
			DBName:   pkgconfig.GetString("postgres.dbname"),
			SSLMode:  pkgconfig.GetString("postgres.sslmode"),
		},
		Redis: RedisConfig{
			Host:     pkgconfig.GetString("redis.host"),
			Port:     pkgconfig.GetString("redis.port"),
			Password: pkgconfig.GetString("redis.password"),
			DB:       pkgconfig.GetInt("redis.db"),
		},
		AI: AIConfig{BaseURL: pkgconfig.GetString("ai.baseurl")},
		JWT: JWTConfig{
			Secret:      pkgconfig.GetString("jwt.secret"),
			ExpireHours: pkgconfig.GetInt("jwt.expire_hours"),
		},
	}

	if cfg.JWT.Secret == "" {
		return nil, errors.New("jwt.secret is empty: set JWT_SECRET env or jwt.secret in configuration.toml")
	}
	if cfg.JWT.ExpireHours <= 0 {
		cfg.JWT.ExpireHours = 24
	}
	return cfg, nil
}

// ensureLoaded 确保 pkg/config 已加载配置文件。
// pkg/config 的 init 仅在二进制同级 conf/ 目录发现配置文件；go run 场景二进制在
// 临时目录，这里按工作目录兜底尝试常见路径，均未命中则报错。
func ensureLoaded() error {
	if pkgconfig.GetConfFile() != "" {
		return nil
	}

	wd, _ := os.Getwd()
	candidates := []string{
		os.Getenv("CONFIG_PATH"),
		filepath.Join("conf", configFileName),
		filepath.Join("cmd", "server", "conf", configFileName),
	}
	for _, path := range candidates {
		if path == "" {
			continue
		}
		if _, err := os.Stat(path); err != nil {
			continue
		}
		return initConfig(path)
	}
	return fmt.Errorf("config file %s not found (cwd=%s): set CONFIG_PATH or run from backend/ directory", configFileName, wd)
}

// initConfig 调用 pkg/config.Init 并把其 panic 转为 error（如 TOML 解析失败）。
func initConfig(path string) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("load config %s failed: %v", path, r)
		}
	}()
	pkgconfig.Init(filepath.Dir(path), filepath.Base(path))
	return nil
}
