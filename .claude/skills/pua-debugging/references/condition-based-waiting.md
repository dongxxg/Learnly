# 条件等待

## 概述

不稳定测试常常用固定延迟来猜时序。这制造了竞态条件：快机器上能过，高负载或 CI 环境就挂。

**核心原则：** 等待你真正关心的条件成立，而不是猜它要多久。

## 何时使用

- 测试中有固定延迟（`Thread.sleep`、`await().atMost()` 无实际条件）
- 测试不稳定（时而通过，负载高时失败）
- 并行运行时测试超时
- 等待异步操作完成

**不适用场景：**
- 测试实际的时序行为（防抖、节流间隔）
- 如果必须用固定超时，必须在注释中说明原因

## 核心模式

```java
// 之前：猜时序
Thread.sleep(50);
var result = getResult();
assertNotNull(result);

// 之后：等条件成立
await().atMost(Duration.ofSeconds(5))
    .until(() -> getResult() != null);
var result = getResult();
assertNotNull(result);
```

## 常用模式速查

| 场景 | 写法 |
|------|------|
| 等待事件 | `await().until(() -> events.stream().anyMatch(e -> e.type == DONE))` |
| 等待状态 | `await().until(() -> machine.getState() == State.READY)` |
| 等待数量 | `await().until(() -> items.size() >= 5)` |
| 等待文件 | `await().until(() -> Files.exists(path))` |
| 复合条件 | `await().until(() -> obj.isReady() && obj.getValue() > 10)` |

## Java/Awaitility 用法

```java
import static org.awaitility.Awaitility.await;
import static java.util.concurrent.TimeUnit.SECONDS;

await()
    .atMost(5, SECONDS)
    .pollInterval(100, TimeUnit.MILLISECONDS)
    .until(() -> condition());
```

## 常见错误

**轮询太快：** `pollInterval(1, MILLISECONDS)` — 浪费 CPU
**正确做法：** 每 50-100ms 轮询一次

**无超时：** 条件永远不成立时无限循环
**正确做法：** 始终设置超时，附带清晰的错误信息

**数据过期：** 循环外缓存了状态
**正确做法：** 在 awaitility lambda 内部调用 getter 获取最新数据

## 固定超时唯一正确的用法

```java
// 工具每 100ms 滴答一次——需要 2 次滴答来验证部分输出
await().until(() -> manager.hasEvent(EventType.TOOL_STARTED)); // 第一步：等条件
Thread.sleep(200);  // 第二步：等定时行为
// 200ms = 100ms 间隔的 2 次滴答——基于已知时序，已标注原因
```

**使用条件：**
1. 先等待触发条件成立
2. 基于已知时序（不是猜的）
3. 注释说明原因
