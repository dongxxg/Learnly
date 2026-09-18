# DevOps Auto - Claude Code Skill

自动化管理 DevOps 流水线的 Claude Code 技能。

## 功能概述

这个技能允许 Claude 全面管理内部 DevOps 系统,包括查询流水线列表、执行流水线、查看构建日志、停止运行中的构建、查询制品/二进制版本/镜像版本、下载制品等,结果以 Markdown 格式展示。

## 主要特性

- ✅ **SSO 自动登录** - 自动管理认证token，无需手动获取
- ✅ 查询 DevOps 流水线列表（显示流水线ID）
- ✅ 执行/触发 DevOps 流水线
- ✅ 查看构建日志和状态
- ✅ 停止运行中的流水线
- ✅ 查询制品/构件列表
- ✅ 查询制品二进制版本列表
- ✅ 查询制品镜像版本列表
- ✅ 下载制品二进制文件（支持自定义文件名格式）
- ✅ 支持多种筛选条件(流水线名称、创建人、收藏状态等)
- ✅ 支持分页查询
- ✅ Markdown 表格格式输出
- ✅ 完善的错误处理
- ✅ 中文字符支持

## 认证配置

### SSO 登录

首次使用时，系统会提示输入用户凭证：

- **用户名**: 公司邮箱用户名（如 wangzk@unitechs.com 的用户名为 wangzk）
- **密码**: 用户密码

凭证会安全存储在 `.devops_config.json` 文件中，后续使用会自动获取token，无需重复输入。

**配置文件位置**: `~/.claude/skills/devops-auto/.devops_config.json`

**Token 管理**:
- Token 会自动获取和刷新
- Token 过期时会自动重新登录
- 无需手动管理 token

## 安装

### 1. 安装依赖

```bash
pip3 install -r requirements.txt
```

### 2. 将技能添加到 Claude Code

将此目录复制到 `~/.claude/skills/` 目录下:

```bash
cp -r devops-auto ~/.claude/skills/
```

## 使用方法

### 在 Claude Code 中使用

当你在 Claude Code 中提出以下类型的请求时,技能会自动激活:

**查询操作:**
- "查询流水线列表"
- "显示我收藏的流水线"
- "查找名称包含 xxx 的流水线"
- "列出 wangzk 创建的流水线"

**执行操作:**

- "执行流水线 xxx-service"
- "触发流水线 ID 为 xxx 的构建"
- "运行 xxxx-view 流水线"

**日志查看:**

- "查看流水线 xxx-service的构建日志"
- "显示流水线 xxx 的最新构建状态"
- "获取流水线构建信息"

**停止操作:**

- "停止流水线 xxx-service"
- "中止流水线 ID 为 xxx 的构建"
- "停止正在运行的构建"

**制品查询:**
- "查询流水线 xxx-service 的制品列表"
- "显示流水线的构件信息"
- "获取制品列表"

**二进制版本查询:**

- "查询流水线 devops-service 的二进制版本列表"
- "显示制品二进制版本"

**镜像版本查询:**
- "查询流水线的镜像版本列表"
- "显示镜像信息"

**制品下载:**
- "下载 devops-service 的最新制品"
- "下载流水线的二进制文件"

### 直接使用脚本

你也可以直接运行脚本:

**查询流水线:**

```bash
# 基本查询(查询收藏的流水线,默认第1页,每页10条)
python3 scripts/query_pipelines.py YOUR_TOKEN

# 自定义分页
python3 scripts/query_pipelines.py YOUR_TOKEN --page-num 2 --page-size 20

# 按流水线名称筛选
python3 scripts/query_pipelines.py YOUR_TOKEN --pipeline-name devops

# 按创建人筛选
python3 scripts/query_pipelines.py YOUR_TOKEN --creator wangzk

# 查询所有流水线(不仅限收藏)
python3 scripts/query_pipelines.py YOUR_TOKEN --favorite false

# 组合多个筛选条件
python3 scripts/query_pipelines.py YOUR_TOKEN --pipeline-name service --creator wangzk --group-id BPCE
```

**执行流水线:**

```bash
# 执行指定 ID 的流水线
python3 scripts/execute_pipeline.py YOUR_TOKEN 202009216556356608

# 先查询再执行
python3 scripts/query_pipelines.py YOUR_TOKEN --pipeline-name devops-service
python3 scripts/execute_pipeline.py YOUR_TOKEN <从查询结果获取的ID>
```

**查看构建日志:**

```bash
# 查看流水线的构建日志
python3 scripts/get_build_logs.py YOUR_TOKEN 202009216556356608

# 输出包含:
# - 最新构建信息(编号、状态、持续时间)
# - 构建阶段详情
# - 最近构建历史
# - 日志查看 URL
```

**停止流水线:**

```bash
# 先获取构建编号
python3 scripts/get_build_logs.py YOUR_TOKEN 202009216556356608

# 停止指定构建
python3 scripts/stop_pipeline.py YOUR_TOKEN 202009216556356608 332
```

**查询制品列表:**

```bash
# 查询指定流水线的制品
python3 scripts/get_packages.py YOUR_TOKEN --pipeline-id 202009216556356608

# 查询所有制品(分页)
python3 scripts/get_packages.py YOUR_TOKEN --page-size 20

# 按制品名称筛选
python3 scripts/get_packages.py YOUR_TOKEN --package-name "unios-view"
```

**查询制品二进制版本列表:**

```bash
# 查询指定流水线的二进制版本
python3 scripts/get_tarballs.py YOUR_TOKEN 201225153iz50i8uyxho

# 查询并输出第一个 Package ID（用于脚本）
python3 scripts/get_tarballs.py YOUR_TOKEN 201225153iz50i8uyxho --output-id

# 分页查询
python3 scripts/get_tarballs.py YOUR_TOKEN 201225153iz50i8uyxho --page-size 20
```

**查询制品镜像版本列表:**

```bash
# 查询指定流水线的镜像版本
python3 scripts/get_images.py YOUR_TOKEN 25121517qg8q2k8119q2

# 带筛选条件查询
python3 scripts/get_images.py YOUR_TOKEN 25121517qg8q2k8119q2 \
  --group-id SCCKPT \
  --image-name premeventshield-view-image \
  --project-id 40941
```

**下载制品二进制:**

```bash
# 方式1: 便捷下载（推荐）- 自动获取最新版本并使用正确文件名
python3 scripts/download_latest.py YOUR_TOKEN 201225153iz50i8uyxho

# 方式2: 手动下载 - 指定 Package ID 和元数据
python3 scripts/download_package.py YOUR_TOKEN 251219124r59c00775hi \
  --pipeline-name devops-service \
  --full-version v21.b11502a.1021 \
  --pipeline-id 201225153iz50i8uyxho

# 指定输出目录
python3 scripts/download_latest.py YOUR_TOKEN 201225153iz50i8uyxho --output-dir /path/to/dir
```

## 参数说明

### 查询流水线参数

**必需参数:**

- `token`: 授权令牌(不需要包含 "bearer " 前缀,脚本会自动添加)

**可选参数:**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `--page-num` | 整数 | 1 | 页码 |
| `--page-size` | 整数 | 10 | 每页条数 |
| `--pipeline-name` | 字符串 | "" | 流水线名称(模糊匹配) |
| `--creator` | 字符串 | "" | 创建人用户名 |
| `--favorite` | 布尔值 | true | 是否只查询收藏的流水线 |
| `--group-id` | 字符串 | "" | 组别 ID |
| `--module-id` | 字符串 | "" | 模块 ID |
| `--product-id` | 字符串 | "" | 产品 ID |
| `--project-id` | 字符串 | "" | 项目 ID |
| `--pipeline-type` | 字符串 | "" | 流水线类型 |

### 执行流水线参数

**必需参数:**

- `token`: 授权令牌(不需要包含 "bearer " 前缀,脚本会自动添加)
- `pipeline_id`: 要执行的流水线 ID (可从查询结果中获取)

### 查看构建日志参数

**必需参数:**

- `token`: 授权令牌(不需要包含 "bearer " 前缀,脚本会自动添加)
- `pipeline_id`: 流水线 ID

### 停止流水线参数

**必需参数:**

- `token`: 授权令牌(不需要包含 "bearer " 前缀,脚本会自动添加)
- `pipeline_id`: 流水线 ID
- `build_number`: 要停止的构建编号 (可从 get_build_logs 获取)

### 查询制品参数

**必需参数:**

- `token`: 授权令牌(不需要包含 "bearer " 前缀,脚本会自动添加)

**可选参数:**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `--page-num` | 整数 | 1 | 页码 |
| `--page-size` | 整数 | 10 | 每页条数 |
| `--pipeline-id` | 字符串 | "" | 流水线 ID |
| `--package-name` | 字符串 | "" | 制品名称 |
| `--module-id` | 字符串 | "" | 模块 ID |
| `--product-id` | 字符串 | "" | 产品 ID |
| `--project-id` | 字符串 | "" | 项目 ID |
| `--package-version` | 字符串 | "" | 制品版本 |
| `--package-status` | 字符串 | "" | 制品状态 |
| `--pipeline-type` | 字符串 | "" | 流水线类型 |

## 输出格式

### 查询输出

查询结果以 Markdown 表格格式输出,包含以下列:

| 列名 | 说明 |
|------|------|
| 流水线名称 | Pipeline Name |
| 所属组别 | Group Name |
| 所属产品 | Product Name |
| 所属模块 | Module Name |
| 所属项目 | Project Name |
| 流水线类型 | Pipeline Type (标准/自定义/模板) |
| 仓库类型 | Repository Type (gitlab/github/etc) |
| 最新操作 | Last Update Time |

**查询输出示例:**

```
## 查询结果
**分页信息**: 第 1/1 页,共 2 条记录

| 流水线名称 | 所属组别 | 所属产品 | 所属模块 | 所属项目 | 流水线类型 | 仓库类型 | 最新操作 |
|-----------|---------|---------|---------|---------|-----------|---------|----------|
| devops-view | 数智底座Data组 | 中盈统一技术平台UniOS | DevOps | 中盈统一技术平台UniOS | 标准流水线 | gitlab | 2025-12-19 13:42:57 |
| devops-service | 数智底座Data组 | 中盈统一技术平台UniOS | DevOps | 中盈统一技术平台UniOS | 标准流水线 | gitlab | 2025-12-19 13:43:18 |
```

### 执行输出

执行结果显示成功或错误信息:

**成功示例:**
```
✅ 成功: 成功
```

**失败示例:**
```
❌ 错误: 流水线不存在或无权限执行
错误代码: 1001
```

## API 详情

### 查询流水线 API

- **URL**: http://192.168.118.247:2011/api/devops/pipeline/list/query
- **方法**: POST
- **协议**: HTTP (忽略 SSL 证书验证)
- **内容类型**: application/json; charset=UTF-8

### 请求头

```
Accept: application/json, text/plain, */*
Accept-Language: zh-CN,zh;q=0.9
Authorization: bearer {token}
Content-Type: application/json; charset=UTF-8
```

### 响应处理

- **成功**: `code = "0000"` - 从 `data.records` 提取流水线列表
- **失败**: `code ≠ "0000"` - 优先使用 `tip` 字段,其次使用 `msg` 字段作为错误信息

### 执行流水线 API

- **URL**: http://192.168.118.247:2011/api/devops/pipeline/excute
- **方法**: POST
- **协议**: HTTP (忽略 SSL 证书验证)
- **内容类型**: application/json; charset=UTF-8

**请求头:**
```
Accept: application/json, text/plain, */*
Authorization: bearer {token}
Content-Type: application/json; charset=UTF-8
```

**请求体:**
```json
{
  "id": "pipeline_id_here"
}
```

**响应处理:**
- **成功**: `code = "0000"` - 流水线执行成功
- **失败**: `code ≠ "0000"` - 优先使用 `tip` 字段,其次使用 `msg` 字段作为错误信息

## 错误处理

脚本会处理以下错误场景:

1. **网络错误**: 连接超时、服务不可达
2. **认证错误**: 无效或过期的令牌
3. **参数错误**: 无效的分页或筛选参数
4. **执行错误**: 流水线不存在或无权限执行
4. **响应解析错误**: 无效的 JSON 响应

所有错误都会返回清晰的中文错误信息。

## 环境要求

- Python 3.6+
- requests 库 (>=2.25.0)
- 网络访问: 能够访问 192.168.118.247:2011
- 授权: 有效的 bearer token

## 开发说明

### 项目结构

```
devops-auto/
├── SKILL.md              # Claude Code 技能定义
├── README.md             # 本文档
├── requirements.txt      # Python 依赖
├── config.py             # 配置管理模块
├── .devops_config.json   # 用户凭证配置文件（自动生成）
└── scripts/
    ├── sso_login.py          # SSO 登录模块
    ├── query_pipelines.py    # 查询流水线脚本
    ├── execute_pipeline.py   # 执行流水线脚本
    ├── get_build_logs.py     # 获取构建日志脚本
    ├── stop_pipeline.py      # 停止流水线脚本
    ├── get_packages.py       # 查询制品列表脚本
    ├── get_tarballs.py       # 查询二进制版本脚本
    ├── get_images.py         # 查询镜像版本脚本
    ├── download_package.py   # 下载制品脚本
    └── download_latest.py    # 下载最新制品脚本
```

### 技能工作流程

1. 用户在 Claude Code 中请求查询流水线
2. Claude 识别到需要使用 devops-auto 技能
3. 系统自动通过 SSO 登录获取授权令牌（首次使用会提示输入凭证）
4. Claude 确定筛选条件
5. Claude 调用相应的脚本（如 `query_pipelines.py`）
6. 脚本返回 Markdown 格式的结果
7. Claude 展示结果给用户

## 贡献

欢迎提交 Issue 和 Pull Request!

## 许可证

MIT License
