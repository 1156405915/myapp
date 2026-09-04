---
name: construction-schedule-planning
description: Deterministically calculate and validate construction WBS schedules, precedence relationships, CPM dates and float, critical paths, duration derivation, labor/equipment/material timelines, resource peaks, and tender-duration closure. Use when forming or reviewing a施工组织设计进度计划、关键线路、横道图数据、资源计划 or赶工策划.
---

# 施工计划计算

## 执行顺序

1. 读取施工范围、工程量、工期目标和工作面约束，先形成符合 [references/plan-contract.md](references/plan-contract.md) 的 `construction-plan.json`。
2. 不得凭文字判断关键线路。运行 [scripts/calculate-schedule.mjs](scripts/calculate-schedule.mjs) 完成关系校验、CPM 和资源计算。
3. 将报告写入 `04-planning/schedule-calculation.json`，将补充计算字段后的计划写入新文件；校验通过后再替换权威计划，不覆盖未经备份的输入文件。
4. 存在环路、未知前置任务、无效工期或计算工期超过招标目标时停止 G4，并进入冲突或存疑确认。
5. 使用计算结果生成横道图、网络图、劳动力曲线和机械材料计划，不在图表中重新手填数据。

```powershell
node scripts/calculate-schedule.mjs --plan <construction-plan.json> --output <schedule-calculation.json> --enriched-plan <construction-plan.calculated.json>
```

## 计算边界

- 支持 FS、SS、FF、SF 关系和正负时距，默认字符串前置关系为 FS、时距 0。
- 没有 `durationDays` 时，仅在工程量、单班组日产能和班组数均有效时推算工期，并保留公式输入。
- CPM 使用连续日历天；施工日历、节假日、停工期和天气损失尚未建模时必须写入假设，不能声称已经考虑。
- `project.durationDays` 是招标或确认工期目标，`calculatedDurationDays` 是逻辑网络计算结果，两者不得互相覆盖。
- 资源曲线按任务计划区间均匀分配。峰值用于校核，不代表实际每日考勤或材料到货记录。
- 算法输出不能替代危大工程论证、专项方案计算或项目负责人确认。
