---
name: information-extraction
description: Extract specified or inferred fields, entities, dates, amounts, requirements, tables, and evidence from documents into structured outputs. Use when the user asks to extract information, populate a field list, convert documents to tables or JSON, identify key parameters, or collect evidence across files.
---

# 信息提取

1. 明确字段清单、数据类型、单位和输出格式；用户未给字段时先根据任务提出合理字段集合。
2. 使用对应格式 Skill 读取源文件，保留表格、标题和页码关系。
3. 每个值必须关联原文证据或定位信息；无法确认时返回空值和原因，不得猜测。
4. 统一日期、金额和计量单位时同时保留原始值与规范化值。
5. 同一字段出现多个值时全部列出，并说明版本、范围或上下文差异。
6. 区分“未找到”“不适用”“原文模糊”和“OCR 无法识别”。
7. 按 [references/output-format.md](references/output-format.md) 输出；用户指定 Schema 时严格遵守字段名称和类型。
8. 大批量提取应先抽样核对，再处理全部文件，并在结果中报告遗漏和异常数量。
