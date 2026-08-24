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

// getSecret 读取 JWT 密钥，优先环境变量 JWT_SECRET（配置键 jwt.secret）。
func getSecret() []byte {
	secret := os.Getenv("JWT_SECRET")
	if secret == "" {
		// 开发期默认值，生产必须通过环境变量注入。
		secret = "learnly-dev-secret-change-me"
	}
	return []byte(secret)
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
