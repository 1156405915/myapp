---
name: construction-intake
description: Inventory and classify construction tender source materials before drafting, with deterministic file hashes, duplicate and version-candidate detection, signature checks, source priority, completeness gates, input change detection, and stage invalidation. Use when receiving a folder or batch of招标文件、补疑、图纸、清单、地勘、管线、现场或投标人资料 for a施工组织设计 workflow.
---

# 施组资料分类整理

## 执行

1. 不修改用户原文件，不跟随符号链接或目录连接，不执行宏、脚本和压缩包内容。
2. 运行 [scripts/inventory.mjs](scripts/inventory.mjs)，将输出写入 `.mayi/tasks/$MAYI_SESSION_ID/construction-plan/00-intake/`。
3. 输入目录较大、预计超过两分钟时使用后台 Bash，保存 `task_id` 并通过 `TaskOutput` 等待。
4. 检查执行器的退出状态和 `completeness-report.json`；存在阻断问题时停止 G0，不直接开始正文。

```powershell
node scripts/inventory.mjs --input <资料目录> --output <construction-plan/00-intake> --task-state <construction-plan/task-state.json>
```

## 固定产物

- `file-inventory.json`：文件分类、大小、哈希、签名、可读性和输入指纹。
- `source-register.json`：来源分类、优先级、重复组和疑似版本组。
- `unreadable-files.json`：空文件、权限错误、签名不符、符号链接和不支持格式。
- `completeness-report.json`：招标主文件、补疑、图纸、清单等 G0 完整性结果。
- `change-summary.json`：相对上一版资料的新增、删除、修改及受影响阶段。

## 判定规则

- 内容哈希相同的文件属于重复候选，不依据文件名认定重复。
- 同一目录中规范化名称相同但哈希不同的文件属于版本候选，最终版本仍按招标证据人工确认。
- 扩展名与文件头不一致、空文件、无法读取和符号链接属于问题项；未知格式只标记未验证，不猜测内容。
- PDF、Office、图片、DWG、HFZF、ZB 的深层内容解析由后续格式技能负责，本技能只验证基础签名和资料可用性。
- `change-summary.json` 显示输入变化时，只将受影响阶段及下游已完成阶段标记为 `stale`。
