package auth_test

import (
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"learnly/backend/internal/auth"
)

// TestMain 注入默认测试密钥（密钥缺失时签发/校验会 fail-fast panic）。
func TestMain(m *testing.M) {
	os.Setenv("JWT_SECRET", "test-secret")
	os.Exit(m.Run())
}

// TestJWT_GenerateAndVerify 往返：签发后解析应还原声明。
func TestJWT_GenerateAndVerify(t *testing.T) {
	token, err := auth.GenerateToken(1, 2, time.Hour)
	require.NoError(t, err)
	require.NotEmpty(t, token)

	claims, err := auth.VerifyToken(token)
	require.NoError(t, err)
	assert.Equal(t, uint64(1), claims.ParentID)
	assert.Equal(t, uint64(2), claims.ChildID)
}

// TestJWT_Expired 过期令牌应返回 ErrTokenExpired。
func TestJWT_Expired(t *testing.T) {
	token, err := auth.GenerateToken(1, 0, -time.Minute)
	require.NoError(t, err)

	_, err = auth.VerifyToken(token)
	assert.ErrorIs(t, err, auth.ErrTokenExpired)
}

// TestJWT_InvalidSignature 换密钥签发后校验应返回 ErrTokenInvalid。
func TestJWT_InvalidSignature(t *testing.T) {
	t.Setenv("JWT_SECRET", "secret-a")
	token, err := auth.GenerateToken(1, 0, time.Hour)
	require.NoError(t, err)

	t.Setenv("JWT_SECRET", "secret-b")
	_, err = auth.VerifyToken(token)
	assert.ErrorIs(t, err, auth.ErrTokenInvalid)
}

// newAuthRouter 构造挂载 JWT 中间件的测试路由，回显注入的上下文值。
func newAuthRouter() *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/protected", auth.Middleware(), func(c *gin.Context) {
		pid, _ := auth.GetParentId(c)
		cid, _ := auth.GetChildId(c)
		c.JSON(http.StatusOK, gin.H{"parentId": pid, "childId": cid})
	})
	return r
}

// TestMiddleware_JWTScenarios 覆盖缺失/无效/过期/有效四种鉴权场景。
func TestMiddleware_JWTScenarios(t *testing.T) {
	t.Setenv("JWT_SECRET", "test-secret")
	r := newAuthRouter()

	validToken, err := auth.GenerateToken(7, 9, time.Hour)
	require.NoError(t, err)
	expiredToken, err := auth.GenerateToken(7, 0, -time.Minute)
	require.NoError(t, err)

	cases := []struct {
		name   string
		header string
		want   int
		code   string
	}{
		{"缺少头", "", 401, "TOKEN_REQUIRED"},
		{"非 Bearer", "Token abc", 401, "TOKEN_REQUIRED"},
		{"无效令牌", "Bearer not-a-jwt", 401, "TOKEN_INVALID"},
		{"过期令牌", "Bearer " + expiredToken, 401, "TOKEN_EXPIRED"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			req := httptest.NewRequest("GET", "/protected", nil)
			if tc.header != "" {
				req.Header.Set(auth.HeaderAuthorization, tc.header)
			}
			r.ServeHTTP(w, req)
			assert.Equal(t, tc.want, w.Code)
			assert.Contains(t, w.Body.String(), tc.code)
		})
	}

	// 有效令牌：放行并注入上下文。
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/protected", nil)
	req.Header.Set(auth.HeaderAuthorization, auth.BearerPrefix+validToken)
	r.ServeHTTP(w, req)
	assert.Equal(t, 200, w.Code)
	assert.Contains(t, w.Body.String(), `"parentId":7`)
	assert.Contains(t, w.Body.String(), `"childId":9`)
}
