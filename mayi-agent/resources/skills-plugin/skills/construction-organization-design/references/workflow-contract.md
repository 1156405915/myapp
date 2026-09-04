# 施组工作流数据契约

开始撰写前应具备：

- `project-facts.json`
- `scoring-matrix.json`
- `requirement-traceability.json`

文件格式见 `bid-document-analysis/references/output-contract.md`。缺失文件时先调用对应技能生成，不在正文中临时维护第二套事实。

## construction-plan.json

```json
{
  "schemaVersion": 1,
  "project": {
    "name": "项目名称",
    "location": "建设地点",
    "durationDays": 365,
    "qualityTarget": "质量目标"
  },
  "workZones": [{ "id": "Z01", "name": "第一施工区", "scope": ["道路工程"] }],
  "wbs": [
    {
      "id": "W01",
      "name": "施工准备",
      "zoneId": "Z01",
      "durationDays": 15,
      "predecessors": [
        { "id": "W00", "type": "FS", "lagDays": 0 }
      ],
      "labor": 20,
      "equipment": ["挖掘机1台"],
      "materials": [
        { "name": "级配碎石", "quantity": 1000, "unit": "t" }
      ]
    }
  ],
  "schedule": {
    "totalDurationDays": 365,
    "calculatedDurationDays": 350,
    "criticalPath": ["W01"],
    "milestones": [{ "name": "开工", "day": 1 }]
  },
  "responses": [
    {
      "scoringItemId": "S01",
      "sections": ["第三章 施工总体部署"],
      "evidenceRefs": ["图3-1 总体施工流程"]
    }
  ],
  "assumptions": [],
  "openQuestions": []
}
```

任务可以直接提供 `durationDays`，也可以提供 `quantity`、`productivityPerCrewDay` 和 `crews`，由 `construction-schedule-planning` 按 `ceil(quantity / (productivityPerCrewDay × crews))` 推算并记录依据。前置关系支持 FS、SS、FF、SF 和 `lagDays`。

`project` 中的字段必须来自 `project-facts.json`。WBS、横道图、网络图、劳动力和机械计划从本文件生成，不得分别手填互相独立的数据。`project.durationDays` 是目标工期，`schedule.calculatedDurationDays` 是逻辑网络计算值，不得相互覆盖。

## consistency-ledger.json

```json
{
  "schemaVersion": 1,
  "checks": [
    {
      "id": "C01",
      "subject": "总工期",
      "authoritativeValue": 365,
      "occurrences": [
        { "location": "正文6.1", "value": 365 },
        { "location": "横道图", "value": 365 }
      ],
      "status": "pass"
    }
  ],
  "openIssues": []
}
```

权威值发生变化时，应更新结构化文件并重新生成正文和图表，不在成品中局部手改。
