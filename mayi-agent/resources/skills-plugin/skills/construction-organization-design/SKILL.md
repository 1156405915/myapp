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

开始任务必须完整读取 [references/execution-workflow.md](references/execution-workflow.md)，按其中的子流程、文件操作、结构化产物和 G0—G8 阶段门执行。不得跳过资料、规则、事实和策划阶段直接生成正文。

1. **资料分类整理**：先调用 `construction-intake` 运行确定性资料清点执行器，识别版本、重复、损坏、扫描件和不可读专有格式，生成资料清单、来源登记和完整性报告。
2. **招标红线与评分**：调用 `bid-document-analysis`，读取 [references/workflow-contract.md](references/workflow-contract.md)，生成否决项、评分矩阵、格式暗标规则和响应追踪表。
3. **项目事实库**：从招标文件、签章图纸、设计说明、清单、地勘、管线、现场和投标人资料建立带证据及状态的事实库，不将参考报告或行业经验写成已确认事实。
4. **标准登记与快照**：调用 `construction-standard-registry`，按项目地区、专业和适用日期查询招标及设计引用标准；草案可生成 `draft` 快照，正式定稿前必须生成只包含已核验版本的 `formal` 快照。
5. **跨文件冲突与确认**：调用 `document-comparison` 对齐招标正文、补疑、清单和不同版本资料，并列保存冲突证据，区分阻断与非阻断问题，集中向用户确认；阻断事实未关闭时不得进入依赖该事实的定稿。
6. **施工策划**：调用 `municipal-construction-methods`，根据项目事实匹配工法卡并生成项目工法快照；再建立施工分区、WBS、总体流程、里程碑、专业穿插、总平面和资源计划，形成 `construction-plan.json`。调用 `construction-schedule-planning` 确定性计算 CPM、关键线路、时差、工期闭合和资源峰值，不得凭文字推断或手填关键线路。重点难点和危大工程采用闭环结构。
7. **高分正文**：根据评分项和工程实体建立章节映射，需要规划章节时读取 [references/chapter-framework.md](references/chapter-framework.md)，调用 `professional-writing` 分章节撰写并保留事实、评分和策划引用。
8. **附表附图**：由 `construction-plan.json` 生成进度、资源、平面和流程图表；需要计算底稿时调用 `xlsx`，不得分别手填相互独立的数据。
9. **最终审查与交付**：调用 `construction-standard-validation` 生成标准引用有效性报告并检查未关闭知识影响；按 [references/consistency-rules.md](references/consistency-rules.md) 生成 `consistency-ledger.json`，调用 `document-review` 检查完整性、事实一致性、其他项目残留和暗标风险。调用 `docx` 排版，需要 PDF 时调用 `pdf`，正式交付前完成公式、结构和逐页视觉检查。合肥青天适配任务由上层 `hefei-qingtian-precheck` 负责预审和纠偏，本技能不递归启动预审工作流。

## 存疑与确认规则

- 事实状态统一使用 `confirmed`、`conflicting`、`not_found`、`pending_confirmation`。
- 向用户提问时按阶段合并问题，列出证据、影响范围和建议选项，不用连续零散追问打断批量解析。
- 非阻断问题可以带明确假设继续形成草案，但必须进入占位符和未决事项清单；阻断问题未关闭时最终状态只能是 `blocked` 或 `draft_with_confirmations`。
- 用户确认作为独立来源记录，不修改或覆盖原始文件证据；输入变化时只重跑受影响阶段及下游阶段。

## 不可突破的边界

- 招标文件、补疑、图纸和清单是项目事实的最高优先来源；通用规范和经验不能覆盖项目明示要求。
- 所有推算必须记录计算依据和假设；无法证实的人员、设备、工期、参数和工程量不得伪装为招标事实。
- 不可解析或未经视觉复核的文件必须标记未验证，不得声称已读取、已核对或已用于定稿。
- 不以篇幅代替针对性，不承诺未经论证的设计变更，不声称获得官方青天模型评分或通过认证。
