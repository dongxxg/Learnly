---
name: skillhub
version: 1.0.0
description: Interact with SkillHub (企业级 Agent 技能注册中心) via CLI — search, install, publish, and manage AI skills. Use this skill whenever the user wants to search for skills, install a skill (e.g. pdf-parser, agentguard), publish a skill package, manage API tokens, or interact with the skill registry at 192.168.6.205. Triggers on: skillhub, skill hub, 技能注册中心, 技能搜索, 安装技能, 发布技能, skill registry, @global/, @namespace/skill-name.
---

# SkillHub CLI — 技能注册中心命令行操作

## 概述

SkillHub 是企业级 Agent 技能注册中心，部署在内网 `192.168.6.205`。本 skill 封装 CLI 工具 `skillhub` 的常用操作命令。

- **Web UI**: http://192.168.6.205
- **API**: http://192.168.6.205:8080

---

## 环境准备

### 安装 CLI

```bash
npm install -g @astron-team/skillhub
```

### 登录到本实例

首先指导用户在 Web UI 创建 API Token（控制台 → 访问凭证 → 创建新 Token），然后：

```bash
skillhub login --token sk_xxxxxxxx --registry http://192.168.6.205
```

> Token 明文只在创建成功时展示一次，之后无法再次查看。如果忘记 Token，需删除旧 Token 重新创建。

---

## 常用命令

### 搜索技能

```bash
# 全文搜索
skillhub search <关键词>

# 示例
skillhub search pdf
skillhub search agentguard
```

### 安装技能

```bash
# 安装到 Claude Code（用户级）
skillhub install <技能坐标> --agent claude-code --scope user

# 安装到 Claude Code（项目级）
skillhub install <技能坐标> --agent claude-code --scope project

# 安装到自定义目录
skillhub install <技能坐标> --dir ~/.claude/skills

# 安装到 Qoder CN CLI（SkillHub 暂无 qoder agent 枚举时使用自定义目录）
skillhub install <技能坐标> --dir ~/.qoder-cn/skills

# 安装到当前项目的 Qoder skills
skillhub install <技能坐标> --dir .qoder/skills

# 示例
skillhub install pdf-parser --agent claude-code --scope user
```

### 发布技能

前提：技能包为 ZIP 文件，根目录必须包含 `SKILL.md`（YAML frontmatter 含 `name` 和 `description`）。

```bash
# 发布到指定命名空间
skillhub publish ./my-skill --namespace my-team

# 发布到全局命名空间
skillhub publish ./my-skill --namespace global
```

**技能包要求**：
| 要求 | 说明 |
|------|------|
| 根文件 `SKILL.md` | 必须，YAML frontmatter 含 `name`、`description` |
| 允许的扩展名 | `.md`, `.json`, `.py`, `.js`, `.ts`, `.sh`, `.yaml`, `.svg`, `.png` 等 50+ 种 |
| 文件大小 | 单文件 ≤ 10MB，总包 ≤ 100MB |
| 文件数量 | ≤ 500 |

---

## 技能坐标系统

| SkillHub 坐标 | CLI 兼容格式 | 说明 |
|--------------|-------------|------|
| `@global/my-skill` | `my-skill` | 平台公共命名空间 |
| `@my-team/my-skill` | `my-team--my-skill` | 团队命名空间 |

CLI 使用兼容格式（`namespace--slug`），Web UI 使用 `@{namespace}/{slug}`。安装时两种格式均可使用。

---

## 支持的 Agent 安装路径

| Agent | 用户级路径 | 项目级路径 |
|-------|-----------|-----------|
| claude-code | `~/.claude/skills/` | `<项目>/.claude/skills/` |
| codex | `~/.codex/skills/` | `<项目>/.codex/skills/` |
| qoder（自定义目录） | `~/.qoder-cn/skills/` | `<项目>/.qoder/skills/` |
| cursor | `~/.cursor/skills/` | `<项目>/.cursor/skills/` |

---

## 其他操作

```bash
# 查看已安装技能
skillhub list

# 查看技能详情
skillhub info <技能坐标>

# 登出
skillhub logout

# 查看帮助
skillhub --help
```

---

## 常见问题

| 问题 | 处理 |
|------|------|
| CLI 登录失败 | 确认 `--registry http://192.168.6.205`；确认 token 未过期；确认已在 Web UI 创建 token |
| 发布技能卡在"审核中" | 普通用户发布需经命名空间管理员审核；联系管理员审核或提权 |
| 上传 ZIP 被拒 | 确认根目录有 `SKILL.md`；文件扩展名在白名单内；文件不超 10MB；总数不超 500 |
| 忘记 API Token | Token 创建后只显示一次；删除旧 Token，在 Web UI 重新创建 |
| 技能被重名 | 同一命名空间内 slug 唯一；换 slug 或换命名空间发布 |
| 浏览器打不开 | 确认能 ping 通 `192.168.6.205`（同内网或已连 VPN） |
