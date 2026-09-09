---
name: construction-intake
description: Inventory and classify construction tender source materials before drafting, with deterministic file hashes, duplicate and version-candidate detection, signature checks, source priority, completeness gates, input change detection, and stage invalidation. Use when receiving a folder or batch of招标文件、补疑、图纸、清单、地勘、管线、现场或投标人资料 for a施工组织设计 workflow.
---

# 施组资料分类整理

## 执行

1. 不修改用户原文件，不跟随符号链接或目录连接，不执行宏、脚本和压缩包内容。
2. 使用宿主提供的资料登记和受控清点工具。底层 [scripts/inventory.mjs](scripts/inventory.mjs) 是文件检查能力，不是工作流编排器。
3. 输入采用项目资料 ID、原始名称与版本，不根据附件 UUID 猜测类别；不通过 Bash 执行资源脚本。
4. 读取真实解析和清点报告，缺少必需资料或解析失败时报告问题。阶段状态、超时、取消与重试由主进程管理，工具未接通则明确受阻。

## 固定产物

- `file-inventory.json`：文件分类、大小、哈希、签名、可读性和输入指纹。
- `source-register.json`：来源分类、优先级、重复组和疑似版本组。
- `unreadable-files.json`：空文件、权限错误、签名不符、符号链接和不支持格式。
- `completeness-report.json`：资料清点检查结果，不等于招标要求或清单阶段已通过。
- `change-summary.json`：相对上一版资料的新增、删除、修改及受影响阶段。

## 判定规则

- 内容哈希相同的文件属于重复候选，不依据文件名认定重复。
- 同一目录中规范化名称相同但哈希不同的文件属于版本候选，最终版本仍按招标证据人工确认。
- 扩展名与文件头不一致、空文件、无法读取和符号链接属于问题项；未知格式只标记未验证，不猜测内容。
- PDF、Office、图片、DWG、HFZF、ZB 的深层内容解析由后续格式技能负责，本技能只验证基础签名和资料可用性。
- 输入变化仅作为报告提交，由主进程按冻结版本决定阶段失效；本技能不写任务状态文件。
