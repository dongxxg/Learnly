---
name: devops
version: 1.0.0
description: Use when managing DevOps pipelines — checking build status, viewing logs, triggering pipelines, querying artifacts, or downloading packages from the internal system. Triggers: pipeline, build, deploy, artifact, /devops
---

# DevOps Pipeline Automation

Automate interactions with the internal DevOps pipeline system, including querying pipeline lists, executing pipelines, viewing build logs, stopping builds, querying packages/artifacts/tarballs/images, downloading package binaries, and displaying results in a structured format.

## Overview

DevOps 流水线自动化技能。通过 Python 脚本封装内部 DevOps 系统 API，提供流水线查询、执行、日志查看、制品查询和下载能力。

## When to Use

- 需要查询/执行 CI/CD 流水线
- 需要查看构建日志或停止正在运行的构建
- 需要查询制品（packages/artifacts/tarballs/images）或下载包
- 触发词：pipeline, build, deploy, artifact, /devops

## When NOT to Use

- 需要 K8s 集群操作 → 使用 `k8s` skill
- 需要管理任务 → 使用 GitLab Issue（`/issue-board` skill）

## Common Mistakes

| 错误 | 正确做法 |
|------|---------|
| Token 过期后重复调用 API 失败 | 检测 401 后自动重新 SSO 登录刷新 Token |
| 不分页直接查询全部流水线 | 使用 `page_size` 和 `page` 参数分页查询 |
| 执行流水线后不检查构建状态 | 执行后轮询构建状态直到完成 |
| 在生产环境执行未验证的流水线 | 先查看流水线配置确认参数 |

## Authentication (SSO Login)

### 1. SSO Login
Authenticate with the DevOps system using SSO credentials. The system automatically manages authentication tokens.

**凭证配置:**
- 用户名: 公司邮箱用户名（如wangzk@unitechs.com的用户名为wangzk）
- 密码: 用户密码（会自动加密存储）
- 配置文件: `.devops_config.json`

**使用方式:**
- 首次使用时，系统会提示输入用户名和密码
- 凭证会安全存储在配置文件中
- 后续使用会自动获取token，无需重复输入
- Token过期时会自动重新登录

## Token Expiration Handling (CRITICAL)

**重要规则: 当任何功能出现token失效或错误时，必须立即停止并重新认证**

当执行任何DevOps操作时，如果遇到以下情况：
- API返回认证失败错误
- Token过期或无效
- 401/403等认证相关错误
- 任何与token相关的错误信息

**必须执行以下步骤:**

1. **立即停止当前任务** - 不要继续尝试执行
2. **要求用户输入凭证** - 提示用户输入用户名和密码
3. **重新获取token** - 使用新凭证调用SSO登录获取新token
4. **保存到配置文件** - 将新凭证加密保存到`.devops_config.json`
5. **继续之前的任务** - 使用新token重新执行之前失败的操作

**示例流程:**
```
1. 执行查询流水线操作 -> 返回认证失败
2. 停止操作，提示: "Token已失效，需要重新登录"
3. 要求用户输入: "请输入用户名:" 和 "请输入密码:"
4. 调用SSO登录获取新token
5. 保存新凭证到配置文件
6. 使用新token重新执行查询流水线操作
```

**错误识别关键词:**
- "认证失败" / "Authentication failed"
- "Token失效" / "Token expired"
- "未授权" / "Unauthorized"
- "权限不足" / "Permission denied"
- HTTP状态码: 401, 403

## Core Operations

### 1. Query Pipeline List

Get list of DevOps pipelines with optional filtering:

```bash
python3 scripts/query_pipelines.py <authorization_token> [options]
```

**Required Parameters:**
- `authorization_token`: Bearer token for API authentication (format: the actual token string, script will add "bearer " prefix)

**Optional Parameters:**
- `--page-num <n>`: Page number (default: 1)
- `--page-size <n>`: Items per page (default: 10)
- `--pipeline-name <name>`: Filter by pipeline name (fuzzy match)
- `--creator <name>`: Filter by creator username
- `--favorite <true|false>`: Filter favorite pipelines (default: true)
- `--group-id <id>`: Filter by group ID
- `--module-id <id>`: Filter by module ID
- `--product-id <id>`: Filter by product ID
- `--project-id <id>`: Filter by project ID
- `--pipeline-type <type>`: Filter by pipeline type

**Output Format:**

Displays a markdown table with the following columns:
- 流水线ID (Pipeline ID)
- 流水线名称 (Pipeline Name)
- 所属组别 (Group Name)
- 所属产品 (Product Name)
- 所属模块 (Module Name)
- 所属项目 (Project Name)
- 流水线类型 (Pipeline Type)
- 仓库类型 (Repository Type)
- 最新操作 (Last Update Time)

### 2. Execute Pipeline

Execute/trigger a DevOps pipeline by its ID:

```bash
python3 scripts/execute_pipeline.py <authorization_token> <pipeline_id>
```

**Required Parameters:**
- `authorization_token`: Bearer token for API authentication (format: the actual token string, script will add "bearer " prefix)
- `pipeline_id`: Pipeline ID to execute (can be obtained from pipeline list query)

**Optional:**
- `--branch <name>`: 直接指定构建分支；省略时交互式展示 refs/list 的分支列表供选择

**构建前置检查 + 分支选择（自动执行）：**
1. 先调用 `POST /api/devops/pipeline/repo/refs/list`（body `{"id": <pipeline_id>}`）获取仓库分支/标签
2. 成功且分支非空：展示可用分支 → 选择（`--branch` 指定或交互式输入编号/名称）→ 用选中分支触发构建（`/excute` body 含 `"branch": "<选中分支>"`）
3. 无可用分支 / code≠0000 / 请求异常 / 指定分支不在列表内：**阻断构建**（报错退出，不触发 `/excute`），错误含真实原因（如流水线不存在、token 过期）

**Output:**
- 分支选择后触发构建 → 成功/失败消息（含所用分支）
- 前置检查/分支校验失败 → 阻断，退出码 1

**Example:**
```bash
python3 scripts/execute_pipeline.py YOUR_TOKEN 23122716h8wxlgx09bx8
```

### 3. Get Build Logs

Get build information and logs for a pipeline:

```bash
python3 scripts/get_build_logs.py <authorization_token> <pipeline_id>
```

**Required Parameters:**
- `authorization_token`: Bearer token for API authentication
- `pipeline_id`: Pipeline ID

**Output:**
- Latest build information (build number, status, duration)
- Build stages with status and duration
- Recent build history
- Log URL for viewing console output

**Example:**
```bash
python3 scripts/get_build_logs.py YOUR_TOKEN 202009216556356608
```

### 4. Stop Pipeline

Stop a running pipeline build:

```bash
python3 scripts/stop_pipeline.py <authorization_token> <pipeline_id> <build_number>
```

**Required Parameters:**
- `authorization_token`: Bearer token for API authentication
- `pipeline_id`: Pipeline ID
- `build_number`: Build number to stop (can be obtained from get_build_logs)

**Output:**
- Success message if pipeline is stopped successfully
- Error message if stop fails

**Example:**
```bash
python3 scripts/stop_pipeline.py YOUR_TOKEN 202009216556356608 332
```

### 5. Get Package List

Query package/artifact list for pipelines:

```bash
python3 scripts/get_packages.py <authorization_token> [options]
```

**Required Parameters:**
- `authorization_token`: Bearer token for API authentication

**Optional Parameters:**
- `--page-num <n>`: Page number (default: 1)
- `--page-size <n>`: Items per page (default: 10)
- `--pipeline-id <id>`: Filter by pipeline ID
- `--package-name <name>`: Filter by package name
- `--module-id <id>`: Filter by module ID
- `--product-id <id>`: Filter by product ID
- `--project-id <id>`: Filter by project ID
- `--package-version <version>`: Filter by package version
- `--package-status <status>`: Filter by package status
- `--pipeline-type <type>`: Filter by pipeline type

**Output:**
- Markdown table with package information
- Columns: 所属流水线、所属产品、所属模块、最新版本、类型、创建时间、制品大小、总空间占用、存在镜像

**Example:**
```bash
python3 scripts/get_packages.py YOUR_TOKEN --pipeline-id 202009216556356608
```

### 6. Get Tarball Binary Version List

Query tarball binary version list for pipelines:

```bash
python3 scripts/get_tarballs.py <authorization_token> <pipeline_id> [options]
```

**Required Parameters:**
- `authorization_token`: Bearer token for API authentication
- `pipeline_id`: Pipeline ID or name

**Optional Parameters:**
- `--page-num <n>`: Page number (default: 1)
- `--page-size <n>`: Items per page (default: 10)
- `--package-version <version>`: Filter by package version
- `--output-id`: Output only the first package ID (for scripting)

**Output:**
- Markdown table with tarball information
- Columns: Package ID, 所属流水线, 所属产品, 所属模块, 所属项目, 制品版本, 创建时间, 制品大小

**Example:**
```bash
python3 scripts/get_tarballs.py YOUR_TOKEN 201225153iz50i8uyxho
```

### 7. Get Image Version List

Query image version list for pipelines:

```bash
python3 scripts/get_images.py <authorization_token> <pipeline_id> [options]
```

**Required Parameters:**
- `authorization_token`: Bearer token for API authentication
- `pipeline_id`: Pipeline ID or name

**Optional Parameters:**
- `--page-num <n>`: Page number (default: 1)
- `--page-size <n>`: Items per page (default: 10)
- `--group-id <id>`: Filter by group ID
- `--image-name <name>`: Filter by image name
- `--project-id <id>`: Filter by project ID

**Output:**
- Markdown table with image information
- Columns: 镜像名称, 镜像大小, docker版本, cpu架构, 维护人, 推送时间

**Example:**
```bash
python3 scripts/get_images.py YOUR_TOKEN 25121517qg8q2k8119q2 --group-id SCCKPT --image-name premeventshield-view-image
```

### 8. Download Package Binary

Download package binary with proper filename format:

```bash
python3 scripts/download_package.py <authorization_token> <package_id> [options]
```

**Required Parameters:**
- `authorization_token`: Bearer token for API authentication
- `package_id`: Package ID to download (from tarball list)

**Optional Parameters:**
- `--net-user-id <id>`: Net user ID (auto-extracted from token if not provided)
- `--output-dir <dir>`: Output directory (default: ~/Downloads)
- `--pipeline-name <name>`: Pipeline name for filename
- `--full-version <version>`: Full version for filename
- `--build-number <number>`: Build number for filename
- `--pipeline-id <id>`: Pipeline ID for filename

**Filename Format:** `pipelineName_fullVersion_buildNumber@pipelineId.tar.gz`

**Example:**
```bash
python3 scripts/download_package.py YOUR_TOKEN 251219124r59c00775hi \
  --pipeline-name devops-service \
  --full-version v21.b11502a.1021 \
  --pipeline-id 201225153iz50i8uyxho
```

### 9. Download Latest Package (Convenience)

Automatically download the latest package with proper filename:

```bash
python3 scripts/download_latest.py <authorization_token> <pipeline_id> [options]
```

**Required Parameters:**
- `authorization_token`: Bearer token for API authentication
- `pipeline_id`: Pipeline ID or name

**Optional Parameters:**
- `--output-dir <dir>`: Output directory (default: ~/Downloads)

**Example:**
```bash
python3 scripts/download_latest.py YOUR_TOKEN 201225153iz50i8uyxho
```

## API Details

底层 HTTP 端点规范（请求头、请求体、响应格式）请参阅 [reference/API_DETAILS.md](./reference/API_DETAILS.md)

## Workflow

**CRITICAL: 所有workflow都必须遵循Token Expiration Handling规则**
- 任何操作遇到token错误时，立即停止并要求用户重新输入凭证
- 重新获取token并保存后，继续执行之前的任务

### Query Pipeline Workflow

When user requests pipeline query operations:

1. **Ask for authorization token** if not provided
2. **Determine filter criteria**: Ask user what filters they want to apply
3. **Execute query**: Run script with appropriate parameters
4. **Handle token errors**: If authentication fails, follow Token Expiration Handling procedure
5. **Display results**: Show markdown table with pipeline information
6. **Handle pagination**: If more results exist, offer to query next page

### Execute Pipeline Workflow

When user requests to execute/trigger a pipeline:

1. **Ask for authorization token** if not provided
2. **Get pipeline ID**: Either from user input or from a previous query result
3. **Execute pipeline**: Run execute script with token and pipeline ID
4. **Handle token errors**: If authentication fails, follow Token Expiration Handling procedure
5. **Display result**: Show success or error message

### Get Build Logs Workflow

When user requests to view build logs or check build status:

1. **Ask for authorization token** if not provided
2. **Get pipeline ID**: Either from user input or from a previous query result
3. **Get build logs**: Run get_build_logs script with token and pipeline ID
4. **Handle token errors**: If authentication fails, follow Token Expiration Handling procedure
5. **Display results**: Show build information, stages, and log URL

### Stop Pipeline Workflow

When user requests to stop a running pipeline:

1. **Ask for authorization token** if not provided
2. **Get pipeline ID**: Either from user input or from a previous query result
3. **Get build number**: Either from user input or from get_build_logs result
4. **Stop pipeline**: Run stop_pipeline script with token, pipeline ID, and build number
5. **Handle token errors**: If authentication fails, follow Token Expiration Handling procedure
6. **Display result**: Show success or error message

### Get Package List Workflow

When user requests to query packages/artifacts:

1. **Ask for authorization token** if not provided
2. **Determine filter criteria**: Ask user what filters they want to apply (pipeline ID, package name, etc.)
3. **Execute query**: Run get_packages script with appropriate parameters
4. **Handle token errors**: If authentication fails, follow Token Expiration Handling procedure
5. **Display results**: Show markdown table with package information
6. **Handle pagination**: If more results exist, offer to query next page

## Usage Examples

完整使用示例（查询、执行、日志、停止、包查询）请参阅 [reference/USAGE_EXAMPLES.md](./reference/USAGE_EXAMPLES.md)

## Technical Notes

- Script uses `requests` library with `verify=False` for internal HTTP
- Handles Chinese character encoding properly (UTF-8)
- Automatically formats response into markdown table
- Captures network exceptions and provides clear error messages
- Token should be provided without "bearer " prefix (script adds it automatically)

## Error Handling

The script handles the following error scenarios:

1. **Network Errors**: Connection timeout, service unreachable
   - Returns: "连接目标服务失败,请检查服务地址或网络状态"

2. **Authentication Errors**: Invalid or expired token
   - Returns error message from API `tip` or `msg` field

3. **Parameter Errors**: Invalid pagination or filter parameters
   - Returns error message from API response

4. **Response Parsing Errors**: Invalid JSON response
   - Returns: "响应数据格式错误"

## Environment Requirements

1. **Python 3**: Python 3.6 or higher
2. **Dependencies**: `requests` library (install via `pip3 install requests`)
3. **Network Access**: Must be able to reach 192.168.118.247:2011
4. **Authorization**: Valid bearer token with appropriate permissions

## Configuration File Format

### .devops_config.json
```json
{
  "username": "wangzk",
  "encrypted_password": "..."
}
```

**注意:**
- 配置文件会自动创建，首次使用时需要设置凭证
- 密码会自动加密存储
- 不要直接编辑配置文件

## Security Notes

1. **密码加密**: 密码会自动加密后存储在配置文件中
2. **配置文件权限**: 确保配置文件有适当的文件权限保护
3. **Token管理**: Token有时效性，过期后会自动重新登录
4. **敏感信息**: 不要在日志或输出中暴露完整的token信息
