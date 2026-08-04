# ADR-0001：monorepo + 三端独立目录

- 状态：Accepted
- 日期：2026-08-04

## 背景

知芽需要：多端前端（H5/小程序/App）、Go 业务平台、Python AI 服务，外加 PostgreSQL/Redis。三端技术栈、发布节奏、扩缩容诉求均不同。

## 决策

采用 **monorepo**，根目录下三端各自独立子目录：

```
Learnly/
├── frontend/      # uni-app + Vue3 + TS（独立 package.json）
├── backend/       # Go（独立 go.mod）
├── ai-service/    # Python（独立 requirements.txt）
├── deploy/        # 编排与环境配置（跨端共享）
└── docs/          # 架构与 ADR
```

各端依赖清单互不污染；`deploy/` 持有跨端编排（docker-compose）与环境变量。

## 备选方案

- **多仓库（polyrepo）**：边界最清晰，但跨端联调、契约同步、统一发版成本高，早期团队负担过重。
- **单模块巨仓**：违反"多语言、独立部署"的现实，构建与依赖管理混乱。

## 权衡

- 优点：一次 `git clone` 即得全栈；跨端改动原子提交；`deploy/` 自然承载联调。
- 代价：仓库随业务增长变大；需 CI 按子目录路径触发（`changes` 过滤）避免全量构建。
- 缓解：各端自带 `.dockerignore`、独立构建产物，互不干扰；后续若某端体积失控，可低成本的子树拆分到独立仓库。

## 后续

- CI 策略：按 `frontend/**` `backend/**` `ai-service/**` 路径分别触发对应流水线。
- 共享类型/契约：API 契约先行（OpenAPI / 手写 .d.ts），避免前端与后端类型漂移。
