---
name: bid-document-analysis
description: Analyze construction and public-procurement tender documents into project facts, scoring criteria, rejection risks, formatting constraints, clarifications, and traceable response requirements. Use when the user asks to read, interpret,拆解, or prepare a response matrix for an招标文件、采购文件、答疑、清单或技术要求; do not use for a generic summary or for drafting the final technical proposal by itself.
---

# 招标文件分析

## 长任务执行

- 批量读取招标文件、扫描件 OCR、跨文件证据索引和全量评分矩阵复核属于耗时任务。按资料文件和输出阶段保存中间 JSON，已完成且输入未变化的文件不得重复解析。
- 预计超过两分钟的转换、OCR 或批处理脚本使用 Bash `run_in_background: true`，保存 `task_id`，通过 `TaskOutput` 使用 `block: true`、`timeout: 30000` 等待；失败或终止时调用 `TaskStop`。

1. 先确认资料集是否包含招标文件正文、技术规范、工程量清单、图纸、合同条件、补疑和澄清；记录缺失项，不修改用户原文件。
2. 调用 `information-extraction` 提取项目事实、工期、质量目标、建设范围、工程量、评分项、否决项、格式和暗标要求，并为每个值保留文件名、章节或页码证据。
3. 阅读 [references/output-contract.md](references/output-contract.md)，建立 `project-facts.json`、`scoring-matrix.json` 和 `requirement-traceability.json`。下游需要正式施组时必须生成这些结构化成果。
4. 按“补疑/澄清优先于原文件、专用条款优先于通用条款、明确要求优先于示例”的原则合并版本；发现冲突时同时保留两处证据并标记待确认，不自行裁决。
5. 严格区分否决条件、资格条件、符合性要求、评分项、合同履约要求和建议性表述；不得把普通建议误报为废标条件。
6. 将每个评分项拆成可响应的证据单元，但不得虚构未公开的模型权重、隐藏公式或评委偏好。
7. 调用 `document-review` 复核遗漏、前后冲突、日期和数字错误，并确认所有结论都能回溯到资料集。
8. 资料不足时输出“已确认、存在冲突、未找到、待确认”四类状态；不得用行业常识替代项目原文。
