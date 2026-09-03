---
name: construction-organization-design
description: Draft or substantially revise a project-specific construction organization design or construction technical bid from tender documents, drawings, quantities, and constraints, with traceable scoring coverage, executable sequencing, resource consistency, and formal DOCX/PDF delivery. Use for施工组织设计、施组方案、施工技术标 or专项深化; do not use for a review-only request or a generic writing task without construction content.
---

# 施工组织设计

## 长任务执行

- 批量解析附件、生成完整施组、全量一致性检查、Office 转 PDF 和逐页渲染属于耗时阶段。使用 `.mayi/tasks/$MAYI_SESSION_ID/construction-plan/task-state.json` 记录阶段、输入摘要、产物路径和完成状态；开始前读取状态，跳过已完成且输入未变化的阶段。
- 预计超过两分钟的脚本必须通过 Bash `run_in_background: true` 启动，保存返回的 `task_id`，随后用 `TaskOutput` 的 `block: true`、`timeout: 30000` 等待。失败或不再需要时使用 `TaskStop`；不得用 `sleep` 或循环高频轮询。
- 每个阶段先写临时产物，校验成功后再更新检查点并进入下一阶段；失败时保留日志和最近成功产物，从最近完成阶段继续，禁止整套流程无条件重跑。

## 工作流

1. 有招标资料时先调用 `bid-document-analysis`，读取 [references/workflow-contract.md](references/workflow-contract.md)，生成或复核项目事实、评分矩阵和响应追踪表；缺少关键资料时明确边界，不套用其他项目参数。
2. 根据评分项和工程实体建立章节映射。章节结构按项目调整，不能用固定目录替代招标文件要求；需要规划章节时读取 [references/chapter-framework.md](references/chapter-framework.md)。
3. 建立施工分区、WBS、总体流程、关键线路、里程碑、专业穿插和资源计划，形成 `construction-plan.json`。工期、人数、设备、材料、工程量及图表必须共享同一组权威数据。
4. 对重点难点和危大工程采用“项目条件—风险后果—施工措施—责任岗位—量化指标—检查频次—异常处置—验收证据”的闭环结构。
5. 调用 `professional-writing` 撰写正文。每个评分项都应有明确标题、项目依据、可执行措施、量化控制、图表或记录证据，避免空话、重复和无依据承诺。
6. 按 [references/consistency-rules.md](references/consistency-rules.md) 生成 `consistency-ledger.json`，调用 `document-review` 检查完整性、事实一致性、规范引用、其他项目残留和暗标风险。
7. 定稿后调用 `docx` 排版；需要PDF时调用 `pdf`。进度、资源表或计算底稿需要表格时调用 `xlsx`。正式交付前完成结构校验和逐页视觉检查。合肥青天适配任务由上层 `hefei-qingtian-precheck` 负责预审和纠偏，本技能只返回草案与结构化成果，不递归启动预审工作流。

## 不可突破的边界

- 招标文件、补疑、图纸和清单是项目事实的最高优先来源；通用规范和经验不能覆盖项目明示要求。
- 所有推算必须记录计算依据和假设；无法证实的人员、设备、工期、参数和工程量不得伪装为招标事实。
- 不以篇幅代替针对性，不承诺未经论证的设计变更，不声称获得官方青天模型评分或通过认证。
