---
name: image-analysis
description: Analyze user-provided images, screenshots, scans, diagrams, charts, and visual evidence with a repeatable evidence-first workflow. Use when the user asks to understand, summarize, compare, inspect, extract visible information from, or answer questions about one or more attached images.
---

# 图片分析

1. 图片识别和普通图片理解使用 `glm-5.3-flash` 模型；不得改用不具备视觉能力的文本模型分析图片。
2. 确认任务类型：整体描述、文字提取、界面检查、图表解读、图片对比、证据核验或基于图片问答。
3. 只分析本条消息实际提供的图片；不得把文件名、用户提示或相邻文档内容冒充图片中可见信息。
4. 先建立全局理解，再检查与问题相关的局部区域。多图任务必须逐图编号，最后再综合比较。
5. 区分“清晰可见”“合理推断”“无法确认”。模糊、遮挡、裁切、分辨率不足或视觉能力限制必须明确说明。
6. 提取文字时保持原有层级、阅读顺序、数字、单位、日期和表格关系；无法辨认的内容用 `[无法辨认]` 标记，不得猜测补全。
7. 分析截图或界面时覆盖页面结构、关键控件、状态、错误信息、可用性和明显视觉异常；不要声称已点击或验证图片之外的交互。
8. 分析图表时说明图表类型、坐标或指标、主要趋势、异常点和可支持的结论，避免把相关性写成因果关系。
9. 按 [references/output-format.md](references/output-format.md) 组织结果；用户指定格式时优先服从。
10. 若当前模型或提供方无法读取图片，立即停止视觉推断并明确告知能力不可用，不得退化为仅根据文件名作答。
