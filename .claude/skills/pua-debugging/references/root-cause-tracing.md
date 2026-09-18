# 根因追溯

## 概述

Bug 往往在调用栈深处爆发。直觉是在报错处修，但这治标不治本。

**核心原则：** 沿调用链反向追溯，找到最初触发点，在源头修复。

## 何时使用

- 错误发生在执行深处（非入口处）
- 栈追踪显示长调用链
- 不清楚无效数据从何而来
- 需要找出哪个测试/代码触发了问题

## 追溯流程

### 1. 观察症状
```
Error: git init failed in /home/user/project/packages/core
```

### 2. 找到直接原因
**什么代码直接导致了这个错误？**
```java
Runtime.getRuntime().exec(new String[]{"git", "init"}, null, projectDir);
```

### 3. 追问：谁调用了它？
```
WorktreeManager.createSessionWorktree(projectDir, sessionId)
  → 被 Session.initializeWorkspace() 调用
  → 被 Session.create() 调用
  → 被测试中 Project.create() 调用
```

### 4. 继续向上追溯
**传入的值是什么？**
- `projectDir = ""`（空字符串）
- 空字符串在 OS 层面解析为 `user.dir`
- 也就是源码目录

### 5. 找到最初触发点
**空字符串从哪来的？**
```java
var context = setupCoreTest();         // 返回 { tempDir: "" }
Project.create("name", context.getTempDir()); // 在 @BeforeEach 之前访问
```

## 添加诊断探针

无法手动追溯时，加探针：

```java
void gitInit(String directory) {
    System.err.println("DEBUG git init: directory=" + directory
        + " cwd=" + System.getProperty("user.dir"));
    new Exception("Stack trace").printStackTrace(System.err);
    // ... 继续执行
}
```

**关键：** 测试中用 `System.err`（不要用 logger——测试框架可能吞掉日志）。

**运行并抓取：**
```bash
./gradlew test 2>&1 | grep 'DEBUG git init'
```

**分析栈追踪：**
- 找测试文件名
- 找到触发调用的行号
- 识别模式（同一个测试？同一个参数？）

## 定位污染源测试

如果知道有问题但不知道哪个测试导致的，逐个跑：

```bash
# Java/Gradle: 跑单个测试类
./gradlew test --tests "com.example.MyTest"

# 或用 --debug 看执行顺序
./gradlew test --debug 2>&1 | grep "Executing test"
```

## 核心原则

```
找到直接原因
  → 能往上追溯一层？
    → 是：反向追溯
    → 否：绝不在表层修复
  → 这是源头吗？
    → 是：在源头修复 + 每层加固验证
    → 否：继续向上追溯
```

**绝不在报错所在处修复。** 反向追溯到最初触发点。
