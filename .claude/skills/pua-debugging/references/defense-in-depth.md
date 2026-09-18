# 纵深防御校验

## 概述

修了一个由非法数据导致的 bug 后，只在一个地方加校验感觉够了。但单点校验会被其他代码路径、重构或 mock 绕过。

**核心原则：** 在数据流经的每一层都加校验，让 bug 在结构上不可能再发生。

## 为什么多层校验

单层校验："我们把 bug 修了"
多层校验："我们让这个 bug 不可能再出现"

不同层捕获不同情况：
- 入口校验拦截大多数非法输入
- 业务逻辑层捕捉边角情况
- 环境保护层阻止特定上下文的安全风险
- 调试日志在其他层都失效时兜底

## 四层防御

### 第一层：入口校验
**目的：** 在 API 边界拒绝明显非法的输入

```java
public Project createProject(String name, Path workingDirectory) {
    if (workingDirectory == null || workingDirectory.toString().isBlank()) {
        throw new IllegalArgumentException("workingDirectory 不能为空");
    }
    if (!Files.exists(workingDirectory)) {
        throw new IllegalArgumentException("workingDirectory 不存在: " + workingDirectory);
    }
    // ... 继续
}
```

### 第二层：业务逻辑校验
**目的：** 确保数据对当前操作有意义

```java
void initializeWorkspace(Path projectDir, String sessionId) {
    Objects.requireNonNull(projectDir, "初始化工作区需要 projectDir");
    // ... 继续
}
```

### 第三层：环境保护
**目的：** 阻止特定上下文中的危险操作

```java
void gitInit(Path directory) {
    // 测试环境下拒绝在临时目录外执行 git init
    if ("test".equals(System.getProperty("app.env"))) {
        Path tmpDir = Path.of(System.getProperty("java.io.tmpdir"));
        if (!directory.toAbsolutePath().startsWith(tmpDir)) {
            throw new SecurityException(
                "测试期间拒绝在临时目录外执行 git init: " + directory);
        }
    }
    // ... 继续
}
```

### 第四层：调试探针
**目的：** 记录上下文用于事后排查

```java
void gitInit(Path directory) {
    log.debug("即将执行 git init: directory={} cwd={}", directory, Path.of("").toAbsolutePath());
    // ... 继续
}
```

## 应用步骤

发现 bug 时：

1. **追踪数据流** — 坏值从哪来？在哪用？
2. **列出所有检查点** — 数据经过的每一个点
3. **每层加校验** — 入口、业务、环境、调试
4. **逐层测试** — 尝试绕过第一层，验证第二层能否捕获

## 核心洞察

四层缺一不可。测试过程中，每层都能捕获其他层漏掉的问题：
- 不同代码路径会绕过入口校验
- Mock 会绕过业务逻辑校验
- 不同平台的边角情况需要环境保护
- 调试日志能识别结构性的误用

**不要满足于单点校验。** 在每一层都加检查。
