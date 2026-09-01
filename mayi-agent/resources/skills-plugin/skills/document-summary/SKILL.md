---
name: document-summary
description: Summarize one or more documents into accurate Chinese executive summaries, structured outlines, key facts, risks, and follow-up questions. Use when the user asks to summarize, condense, explain, outline, or answer questions from PDFs, Word documents, spreadsheets, presentations, reports, contracts, tenders, or long text.
---

# 文档总结

1. 确认总结对象、受众、长度和关注重点；用户未指定时采用“执行摘要 + 关键事实 + 风险与待确认事项”。
2. 先调用对应格式 Skill 读取文件；不得把文件名、目录结构或工具输出当作文档正文。
3. 区分原文事实、合理推断和缺失信息。不要补造金额、日期、责任人、结论或引用。
4. 长文档按章节分块理解，再进行全局归纳，避免只总结开头或目录。
5. 保留关键数字、日期、主体、范围、条件、例外和结论，并标注可定位的章节、页码或工作表来源。
6. 多文件任务先分别总结，再说明共同点、差异和冲突。
7. 按 [references/output-format.md](references/output-format.md) 组织结果；用户指定格式时优先服从用户要求。
8. 用户要求生成正式文件时，将确认后的内容交给 `docx`、`pptx`、`xlsx` 或 `pdf` Skill 完成排版和质量检查。
