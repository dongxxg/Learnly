package auth

import (
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Claims 自定义 JWT 声明。含 parent_id、child_id 与标准过期声明。
type Claims struct {
	ParentID uint64 `json:"parent_id"`
	ChildID  uint64 `json:"child_id"` // 0 表示未选择儿童
	jwt.RegisteredClaims
}

var (
	// ErrTokenExpired 令牌过期。
	ErrTokenExpired = errors.New("token expired")
	// ErrTokenInvalid 令牌无效。
	ErrTokenInvalid = errors.New("token invalid")
)

// configuredSecret 由 main 启动时经 Init 注入的配置密钥。
var configuredSecret []byte

// Init 注入配置密钥（config.Load 后立即调用）。空密钥直接拒绝启动。
func Init(secret string) {
	if secret == "" {
		panic("JWT 密钥为空：请通过配置 jwt.secret 或环境变量 JWT_SECRET 提供")
	}
	configuredSecret = []byte(secret)
}

// getSecret 读取 JWT 密钥：优先 Init 注入的配置，其次环境变量 JWT_SECRET。
// 两者皆空时 panic——静默回退到公开常量会让任何人可伪造 JWT（越权），绝不回退。
func getSecret() []byte {
	if len(configuredSecret) > 0 {
		return configuredSecret
	}
	if env := os.Getenv("JWT_SECRET"); env != "" {
		return []byte(env)
	}
	panic("JWT 密钥未注入：启动时须调用 auth.Init 或设置 JWT_SECRET")
}

// GenerateToken 签发 JWT。expire 为过期时长。
func GenerateToken(parentID, childID uint64, expire time.Duration) (string, error) {
	claims := Claims{
		ParentID: parentID,
		ChildID:  childID,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(expire)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			Issuer:    "learnly",
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(getSecret())
}

// VerifyToken 解析并校验 JWT。返回 claims 或错误。
func VerifyToken(tokenStr string) (*Claims, error) {
	token, err := jwt.ParseWithClaims(tokenStr, &Claims{}, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return getSecret(), nil
	})
	if err != nil {
		// 区分过期与签名错误。
		if errors.Is(err, jwt.ErrTokenExpired) {
			return nil, ErrTokenExpired
		}
		return nil, ErrTokenInvalid
	}
	claims, ok := token.Claims.(*Claims)
	if !ok || !token.Valid {
		return nil, ErrTokenInvalid
	}
	return claims, nil
}
