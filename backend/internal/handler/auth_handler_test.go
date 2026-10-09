package handler_test

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"learnly/backend/internal/handler"
	"learnly/backend/internal/service"
)

// mockAuthService 仅覆写被测方法。
type mockAuthService struct {
	service.AuthService
	registerResult *service.AuthResult
	registerErr    error
	loginResult    *service.AuthResult
	loginErr       error
}

func (m *mockAuthService) Register(ctx context.Context, phone, password string) (*service.AuthResult, error) {
	return m.registerResult, m.registerErr
}

func (m *mockAuthService) Login(ctx context.Context, phone, password string) (*service.AuthResult, error) {
	return m.loginResult, m.loginErr
}

func newAuthHandlerRouter(svc service.AuthService) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.POST("/api/auth/register", handler.NewAuthHandler(svc).Register)
	r.POST("/api/auth/login", handler.NewAuthHandler(svc).Login)
	return r
}

func postJSON(r *gin.Engine, path, body string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	return w
}

func TestAuthHandler_Register(t *testing.T) {
	t.Run("成功返回 201", func(t *testing.T) {
		svc := &mockAuthService{registerResult: &service.AuthResult{Token: "jwt", ParentID: 42}}
		w := postJSON(newAuthHandlerRouter(svc), "/api/auth/register", `{"phone":"13800138000","password":"123456"}`)
		require.Equal(t, 201, w.Code)
		var body map[string]any
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
		assert.Equal(t, "jwt", body["token"])
	})

	t.Run("参数缺失返回 400", func(t *testing.T) {
		svc := &mockAuthService{}
		w := postJSON(newAuthHandlerRouter(svc), "/api/auth/register", `{"phone":"13800138000"}`)
		assert.Equal(t, 400, w.Code)
		assert.Contains(t, w.Body.String(), "INVALID_PARAMS")
	})

	t.Run("密码过短返回 400", func(t *testing.T) {
		svc := &mockAuthService{}
		w := postJSON(newAuthHandlerRouter(svc), "/api/auth/register", `{"phone":"13800138000","password":"123"}`)
		assert.Equal(t, 400, w.Code)
	})

	t.Run("手机号已注册返回 409", func(t *testing.T) {
		svc := &mockAuthService{registerErr: assert.AnError}
		// handler 按错误文案分流，模拟业务层返回的确切文案。
		svc.registerErr = errPhoneExists
		w := postJSON(newAuthHandlerRouter(svc), "/api/auth/register", `{"phone":"13800138000","password":"123456"}`)
		assert.Equal(t, 409, w.Code)
		assert.Contains(t, w.Body.String(), "PHONE_EXISTS")
	})

	t.Run("其他错误返回 400", func(t *testing.T) {
		svc := &mockAuthService{registerErr: assert.AnError}
		w := postJSON(newAuthHandlerRouter(svc), "/api/auth/register", `{"phone":"13800138000","password":"123456"}`)
		assert.Equal(t, 400, w.Code)
		assert.Contains(t, w.Body.String(), "REGISTER_FAILED")
	})
}

func TestAuthHandler_Login(t *testing.T) {
	t.Run("成功返回 200", func(t *testing.T) {
		svc := &mockAuthService{loginResult: &service.AuthResult{Token: "jwt", ParentID: 1}}
		w := postJSON(newAuthHandlerRouter(svc), "/api/auth/login", `{"phone":"13800138000","password":"123456"}`)
		require.Equal(t, 200, w.Code)
		assert.Contains(t, w.Body.String(), "token")
	})

	t.Run("凭证错误返回 401", func(t *testing.T) {
		svc := &mockAuthService{loginErr: errBadCredentials}
		w := postJSON(newAuthHandlerRouter(svc), "/api/auth/login", `{"phone":"13800138000","password":"bad"}`)
		assert.Equal(t, 401, w.Code)
		assert.Contains(t, w.Body.String(), "BAD_CREDENTIALS")
	})

	t.Run("其他错误返回 400", func(t *testing.T) {
		svc := &mockAuthService{loginErr: assert.AnError}
		w := postJSON(newAuthHandlerRouter(svc), "/api/auth/login", `{"phone":"13800138000","password":"123456"}`)
		assert.Equal(t, 400, w.Code)
		assert.Contains(t, w.Body.String(), "LOGIN_FAILED")
	})

	t.Run("参数缺失返回 400", func(t *testing.T) {
		svc := &mockAuthService{}
		w := postJSON(newAuthHandlerRouter(svc), "/api/auth/login", `{}`)
		assert.Equal(t, 400, w.Code)
	})
}

// 与 service 层错误文案保持一致的哨兵错误（仅测试用）。
var (
	errPhoneExists    = errText("手机号已注册")
	errBadCredentials = errText("手机号或密码错误")
)

type errText string

func (e errText) Error() string { return string(e) }
