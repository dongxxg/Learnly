package service

import (
	"context"
	"errors"
	"time"

	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"

	appauth "learnly/backend/internal/auth"
	"learnly/backend/internal/model"
	"learnly/backend/internal/repository"
)

// AuthResult 注册/登录返回结果。
type AuthResult struct {
	Token     string       `json:"token"`
	ExpiresIn int64        `json:"expiresIn"` // 秒
	ParentID  uint64       `json:"parentId"`
	Children  []ChildBrief `json:"children"`
}

// ChildBrief 儿童档案简要信息。
type ChildBrief struct {
	ID     uint64 `json:"id"`
	Name   string `json:"name"`
	Avatar string `json:"avatar"`
}

// AuthService 用户认证业务逻辑接口。
type AuthService interface {
	Register(ctx context.Context, phone, password string) (*AuthResult, error)
	Login(ctx context.Context, phone, password string) (*AuthResult, error)
}

// authService 实现 AuthService。
type authService struct {
	parentRepo  repository.ParentRepository
	childRepo   repository.ChildProfileRepository
	tokenExpire time.Duration
}

// NewAuthService 构造 AuthService。
func NewAuthService(parentRepo repository.ParentRepository, childRepo repository.ChildProfileRepository) AuthService {
	return &authService{
		parentRepo:  parentRepo,
		childRepo:   childRepo,
		tokenExpire: 72 * time.Hour,
	}
}

// Register 手机号+密码注册。手机号唯一性校验 + bcrypt 哈希 + JWT 签发。
func (s *authService) Register(ctx context.Context, phone, password string) (*AuthResult, error) {
	if phone == "" || password == "" {
		return nil, errors.New("手机号与密码不能为空")
	}
	if len(password) < 6 {
		return nil, errors.New("密码至少 6 位")
	}

	// 手机号唯一性校验。
	_, err := s.parentRepo.FindByPhone(ctx, phone)
	if err == nil {
		return nil, errors.New("手机号已注册")
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}

	// bcrypt 哈希。
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return nil, err
	}

	// 创建 Parent。
	parent := &model.Parent{Phone: phone, PasswordHash: string(hash)}
	if err := s.parentRepo.Create(ctx, parent); err != nil {
		return nil, err
	}

	// 签发 JWT。
	token, err := appauth.GenerateToken(parent.ID, 0, s.tokenExpire)
	if err != nil {
		return nil, err
	}

	return &AuthResult{
		Token:     token,
		ExpiresIn: int64(s.tokenExpire.Seconds()),
		ParentID:  parent.ID,
		Children:  []ChildBrief{},
	}, nil
}

// Login 手机号+密码登录。密码验证 + JWT 签发。
func (s *authService) Login(ctx context.Context, phone, password string) (*AuthResult, error) {
	if phone == "" || password == "" {
		return nil, errors.New("手机号与密码不能为空")
	}

	parent, err := s.parentRepo.FindByPhone(ctx, phone)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, errors.New("手机号或密码错误")
		}
		return nil, err
	}

	// bcrypt 密码比对。
	if err := bcrypt.CompareHashAndPassword([]byte(parent.PasswordHash), []byte(password)); err != nil {
		return nil, errors.New("手机号或密码错误")
	}

	// 加载儿童档案。
	children, err := s.childRepo.FindByParentID(ctx, parent.ID)
	if err != nil {
		return nil, err
	}
	briefs := make([]ChildBrief, 0, len(children))
	for _, c := range children {
		briefs = append(briefs, ChildBrief{ID: c.ID, Name: c.Name, Avatar: c.Avatar})
	}

	// 签发 JWT（默认 childId=0，前端需调用 profiles/switch 选择儿童）。
	token, err := appauth.GenerateToken(parent.ID, 0, s.tokenExpire)
	if err != nil {
		return nil, err
	}

	return &AuthResult{
		Token:     token,
		ExpiresIn: int64(s.tokenExpire.Seconds()),
		ParentID:  parent.ID,
		Children:  briefs,
	}, nil
}
