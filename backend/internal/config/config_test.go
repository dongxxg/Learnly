package config

import (
	"strings"
	"testing"

	pkgconfig "github.com/dongxxg/go-tools/config"
)

// 测试用配置文件路径：internal/config 相对 cmd/server/conf。
const testConfPath = "../../cmd/server/conf/configuration.toml"

// 依赖 pkg/config 全局状态，用例须按声明顺序执行，禁止 t.Parallel。

func TestLoad_MissingConfigFile(t *testing.T) {
	if pkgconfig.GetConfFile() != "" {
		t.Skip("config already loaded by earlier test")
	}
	t.Setenv("CONFIG_PATH", "")

	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("expect not-found error, got: %v", err)
	}
}

func TestLoad_MissingJWTSecret(t *testing.T) {
	t.Setenv("CONFIG_PATH", testConfPath)
	t.Setenv("JWT_SECRET", "")

	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "jwt.secret is empty") {
		t.Fatalf("expect jwt.secret empty error, got: %v", err)
	}
}

func TestLoad_OK(t *testing.T) {
	t.Setenv("CONFIG_PATH", testConfPath)
	t.Setenv("JWT_SECRET", "test-secret")
	t.Setenv("SERVER_PORT", "9090")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}

	// 环境变量覆盖文件值
	if cfg.Server.Port != "9090" {
		t.Errorf("Server.Port = %q, want 9090 (env override)", cfg.Server.Port)
	}
	// 文件默认值
	if cfg.Server.Mode != "debug" {
		t.Errorf("Server.Mode = %q, want debug", cfg.Server.Mode)
	}
	if cfg.Postgres.Host != "localhost" || cfg.Postgres.Port != "5432" {
		t.Errorf("Postgres = %s:%s, want localhost:5432", cfg.Postgres.Host, cfg.Postgres.Port)
	}
	if cfg.Redis.DB != 0 {
		t.Errorf("Redis.DB = %d, want 0", cfg.Redis.DB)
	}
	if cfg.JWT.Secret != "test-secret" {
		t.Errorf("JWT.Secret = %q, want test-secret", cfg.JWT.Secret)
	}
	if cfg.JWT.ExpireHours != 24 {
		t.Errorf("JWT.ExpireHours = %d, want 24", cfg.JWT.ExpireHours)
	}
	if !strings.Contains(cfg.Postgres.DSN(), "host=localhost port=5432") {
		t.Errorf("DSN unexpected: %s", cfg.Postgres.DSN())
	}
}
