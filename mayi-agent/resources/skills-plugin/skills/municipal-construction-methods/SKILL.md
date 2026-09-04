---
name: municipal-construction-methods
description: Match versioned municipal construction method cards to confirmed project facts and freeze selected methods into project snapshots. Use for市政道路、排水、管综、交通、照明、绿化、交通导改的施工策划、工法选择、资源风险分析和施组正文编制；缺少项目事实时必须转入存疑确认。
---

# 市政工程专业工法

1. 从项目事实库提取专业范围和事实标识，不根据项目名称猜测工程实体、地质、地下水、管线或设计参数。
2. 调用 `query_method_cards`，传入事实标识、专业和草案或正式模式。
3. 按候选结果处理：
   - `applicable`：项目事实满足当前卡片条件。
   - `conditional`：缺少必要事实，只能形成带未决事项的草案。
   - 不返回被排除条件命中的卡片。
4. 读取候选卡中的流程、控制点、质量证据、安全风险、环境措施和禁止假设；不得自行补写控制参数。
5. 选择工法后调用 `create_project_method_snapshot` 固定卡片版本和项目事实哈希。
6. 正式快照必须绑定正式标准快照，只允许 `approved` 工法卡，且不得包含必需的假设来源参数。
7. 后续施工策划和正文只引用主进程返回的工法快照；事实变化时重新匹配并创建新修订，不改写旧快照。

内置卡片位于 `cards/`，其 `reviewed` 状态表示完成结构审核，但未达到 `approved` 前不能进入正式快照。
