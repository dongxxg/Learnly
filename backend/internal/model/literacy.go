package model

import "time"

// Parent 家长账号。一个家长可关联多个儿童档案。
type Parent struct {
	ID           uint64 `gorm:"primaryKey"`
	Phone        string `gorm:"size:20;uniqueIndex;not null"` // 手机号，登录账号
	PasswordHash string `gorm:"size:255;not null"`            // bcrypt 哈希
	CreatedAt    time.Time
	Children     []ChildProfile `gorm:"foreignKey:ParentID"`
}

// ChildProfile 儿童档案。每个儿童有独立的学习进度。
type ChildProfile struct {
	ID        uint64 `gorm:"primaryKey"`
	ParentID  uint64 `gorm:"index;not null"` // 关联家长
	Name      string `gorm:"size:50;not null"`
	Avatar    string `gorm:"size:255"` // 头像 URL，可选
	CreatedAt time.Time
	Parent    Parent   `gorm:"foreignKey:ParentID"`
	Progresses []Progress `gorm:"foreignKey:ChildID"`
}

// Character 汉字字库。内置几百常用字，启动时幂等加载。
type Character struct {
	ID        uint64 `gorm:"primaryKey"`
	Char      string `gorm:"size:8;uniqueIndex;not null"` // 汉字本身，唯一键
	Pinyin    string `gorm:"size:64;not null"`            // 拼音
	Strokes   int    `gorm:"not null"`                    // 笔画数
	Level     int    `gorm:"index;default:1;not null"`    // 难度等级 1-5
	Definition string `gorm:"size:512"`                   // 释义
	OrderData string `gorm:"size:255"`                    // 笔顺动画占位 URL
	CreatedAt time.Time
}

// Progress 学习进度。唯一约束 (child_id, character_id)。
type Progress struct {
	ID          uint64 `gorm:"primaryKey"`
	ChildID     uint64 `gorm:"uniqueIndex:idx_child_char;index;not null"`
	CharacterID uint64 `gorm:"uniqueIndex:idx_child_char;index;not null"`
	Status      string `gorm:"size:16;default:'unlearned';not null"` // unlearned / learning / learned
	LastStudyAt *time.Time                                           // 最近学习时间
	CompletedAt *time.Time                                           // 完成时间
	CreatedAt   time.Time
	UpdatedAt   time.Time
	Child       ChildProfile `gorm:"foreignKey:ChildID"`
	Character   Character    `gorm:"foreignKey:CharacterID"`
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
