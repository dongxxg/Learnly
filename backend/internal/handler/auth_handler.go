package handler

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"

	"learnly/backend/internal/service"
)

// AuthHandler 用户认证 HTTP 处理器。
type AuthHandler struct {
	authService service.AuthService
}

// NewAuthHandler 构造 AuthHandler。
func NewAuthHandler(authService service.AuthService) *AuthHandler {
	return &AuthHandler{authService: authService}
}

// registerReq 注册请求。
type registerReq struct {
	Phone    string `json:"phone" binding:"required"`
	Password string `json:"password" binding:"required,min=6"`
}

// loginReq 登录请求。
type loginReq struct {
	Phone    string `json:"phone" binding:"required"`
	Password string `json:"password" binding:"required"`
}

// Register POST /api/auth/register。
func (h *AuthHandler) Register(c *gin.Context) {
	var req registerReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": "INVALID_PARAMS", "message": err.Error()})
		return
	}
	result, err := h.authService.Register(c.Request.Context(), req.Phone, req.Password)
	if err != nil {
		if err.Error() == "手机号已注册" {
			c.JSON(http.StatusConflict, gin.H{"code": "PHONE_EXISTS", "message": err.Error()})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"code": "REGISTER_FAILED", "message": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, result)
}

// Login POST /api/auth/login。
func (h *AuthHandler) Login(c *gin.Context) {
	var req loginReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": "INVALID_PARAMS", "message": err.Error()})
		return
	}
	result, err := h.authService.Login(c.Request.Context(), req.Phone, req.Password)
	if err != nil {
		if errors.Is(err, errors.New("手机号或密码错误")) || err.Error() == "手机号或密码错误" {
			c.JSON(http.StatusUnauthorized, gin.H{"code": "BAD_CREDENTIALS", "message": err.Error()})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"code": "LOGIN_FAILED", "message": err.Error()})
		return
	}
	c.JSON(http.StatusOK, result)
}
