# Debate/Reviewer dispatch 必传 change-name

dispatch Debate / Reviewer（**无论 pipeline 还是 natural 模式**）时，**必须**在 prompt 里：

1. 明确指定 `<change-name>`（让 agent 知道往哪个 shared-state 目录写）
2. 提示 agent 结束时调用 `orchestrator.js write-shared-state <change-name> --key concerns`

不传 change-name 会导致 agent 无法写 `concerns.json`，对抗审计/评审产出丢失——daily-report 的 `concern_stats` 会变成 false-negative（"对抗没产出 P0/P1"假象）。

- **pipeline 模式**：由 `dispatch-design-review.md` / `dispatch-code-review.md` 模板自动注入 change-name，无需 PM 手动传
- **natural 模式**（PM 直接 `Agent(Debate, ...)` / `Agent(Reviewer, ...)`）：PM **必须**在 prompt 里显式给 change-name，并提示落盘。agent 文件（debate.md / reviewer.md 的"产出契约"段）已强制约束 agent 落盘
