---
name: construction-standard-validation
description: Validate construction-standard references against the current project snapshot and trace knowledge changes that require revalidation. Use before finalizing施工组织设计、技术标、专项方案 or工法卡 when checking standard numbers, names, effective dates, abolished or superseded status, snapshot coverage, and clause verifiability.
---

# 工程标准引用校验

1. 从正文、策划、招标、设计和工法卡中整理结构化引用，包括编号、名称、条款号、来源类型、来源标识和位置。
2. 调用 `validate_standard_references`，必须使用项目适用日期，不使用当前日期代替投标截止日期或合同约定日期。
3. 按规则处理问题：
   - `blocking`：正式交付前必须关闭，包括无正式快照、引用不在快照、已废止、未实施或未核验。
   - `high`：重点复核被替代、修订或条款不存在的引用。
   - `medium/low`：名称不一致、只有元数据而无法核验条款等证据不足问题。
4. 条款库没有合法全文时，只能报告 `clause_unverified`，不得声称条款有效或不存在。
5. 将生成的 `standards-validation-rN.json` 纳入 G7 最终审查产物。
6. 调用 `list_project_knowledge_impacts` 检查标准状态变化造成的未关闭影响；存在高风险影响时重新执行标准快照、工法匹配和相关章节复核。
7. 不自行修改标准状态、关闭影响项或覆盖历史项目快照。
