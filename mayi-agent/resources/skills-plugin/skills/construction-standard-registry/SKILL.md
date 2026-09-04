---
name: construction-standard-registry
description: Query, verify, freeze, and cite construction standards by project location, discipline, and applicable date through Mayi's trusted local-first registry. Use when preparing施工组织设计、技术标、专项方案、规范清单 or checking whether a national, industry, Anhui, or Hefei standard is applicable; never treat general web search as official verification.
---

# 工程标准登记与项目快照

## 执行顺序

1. 从已确认的项目事实中取得项目地区、专业范围和标准适用日期。日期缺失时标记 `pending_confirmation`，不得用当前日期替代投标或项目适用日期。
2. 对招标文件、设计说明、图纸和清单明确引用的每个标准调用 `query_standard`。按编号逐项查询，不用 WebSearch/WebFetch 的结果替代受控查询。
3. 记录工具返回的 `cacheState`、`verificationStatus`、`sourceHash` 和 `usableForFormal`：
   - `hit` 且 `usableForFormal=true`：可进入正式候选清单。
   - `stale` 或 `refresh_failed`：可用于草案，但必须列入复核事项。
   - `miss`、`negative_hit`：列入缺失标准清单，不得猜测版本。
   - `pending_review`、`discovered`：只作为待审核线索。
4. 将招标明确、设计明确、强制性、地方性和工法依据分别标注选择原因。
5. 草案阶段可调用 `create_project_standard_snapshot` 创建 `draft` 快照；正式定稿前只能使用 `verified_official` 或 `approved` 版本创建 `formal` 快照。
6. 调用 `latest_project_standard_snapshot` 读取主进程生成的最近快照，并以其中的 `versionId`、`sourceHash` 和相对产物路径作为后续引用依据。

## 约束

- 项目明示要求优先于通用经验；发现冲突时并列证据并请求确认，不自行覆盖。
- 不通过 Bash、临时脚本或 SQLite 命令访问全局标准库。
- 不把标准名称、版本、效力状态或发布日期写成已确认事实，除非受控工具返回该字段。
- 不把待审核、查询失败、已废止或被拒绝的记录用于正式施组定稿。
- 全局标准库更新不得改写既有项目快照；需要更新时创建新修订快照。
- 快照结构校验规则见 [references/project-standard-snapshot.schema.json](references/project-standard-snapshot.schema.json)。
