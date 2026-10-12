package model

import "time"

// Parent 家长账号。一个家长可关联多个儿童档案。
type Parent struct {
	ID           uint64         `gorm:"primaryKey" json:"id"`
	Phone        string         `gorm:"size:20;uniqueIndex;not null" json:"phone"` // 手机号，登录账号
	PasswordHash string         `gorm:"size:255;not null" json:"-"`                // bcrypt 哈希，禁止外泄
	CreatedAt    time.Time      `json:"createdAt"`
	Children     []ChildProfile `gorm:"foreignKey:ParentID" json:"-"`
}

// ChildProfile 儿童档案。每个儿童有独立的学习进度。
type ChildProfile struct {
	ID         uint64     `gorm:"primaryKey" json:"id"`
	ParentID   uint64     `gorm:"index;not null" json:"parentId"` // 关联家长
	Name       string     `gorm:"size:50;not null" json:"name"`
	Avatar     string     `gorm:"size:255" json:"avatar,omitempty"` // 头像 URL，可选
	CreatedAt  time.Time  `json:"createdAt"`
	Parent     Parent     `gorm:"foreignKey:ParentID" json:"-"`
	Progresses []Progress `gorm:"foreignKey:ChildID" json:"-"`
}

// Character 汉字字库。内置几百常用字，启动时幂等加载。
type Character struct {
	ID         uint64    `gorm:"primaryKey" json:"id"`
	Char       string    `gorm:"size:8;uniqueIndex;not null" json:"char"` // 汉字本身，唯一键
	Pinyin     string    `gorm:"size:64;not null" json:"pinyin"`          // 拼音
	Strokes    int       `gorm:"not null" json:"strokes"`                 // 笔画数
	Level      int       `gorm:"index;default:1;not null" json:"level"`   // 难度等级 1-5
	Definition string    `gorm:"size:512" json:"definition"`              // 释义
	OrderData  string    `gorm:"size:255" json:"orderData,omitempty"`     // 笔顺动画占位 URL
	CreatedAt  time.Time `json:"createdAt"`
}

// Progress 学习进度。唯一约束 (child_id, character_id)。
type Progress struct {
	ID          uint64       `gorm:"primaryKey" json:"id"`
	ChildID     uint64       `gorm:"uniqueIndex:idx_child_char;index;not null" json:"childId"`
	CharacterID uint64       `gorm:"uniqueIndex:idx_child_char;index;not null" json:"characterId"`
	Status      string       `gorm:"size:16;default:'unlearned';not null" json:"status"` // unlearned / learning / learned
	LastStudyAt *time.Time   `json:"lastStudyAt,omitempty"`                              // 最近学习时间
	CompletedAt *time.Time   `json:"completedAt,omitempty"`                              // 完成时间
	CreatedAt   time.Time    `json:"createdAt"`
	UpdatedAt   time.Time    `json:"updatedAt"`
	Child       ChildProfile `gorm:"foreignKey:ChildID" json:"-"`
	Character   Character    `gorm:"foreignKey:CharacterID" json:"-"`
}

// ProgressStatus 进度状态常量。
const (
	StatusUnlearned = "unlearned"
	StatusLearning  = "learning"
	StatusLearned   = "learned"
)

// AllModels 返回所有 GORM 模型，供迁移统一调用。
func AllModels() []interface{} {
	return []interface{}{
		&Parent{},
		&ChildProfile{},
		&Character{},
		&Progress{},
	}
}
