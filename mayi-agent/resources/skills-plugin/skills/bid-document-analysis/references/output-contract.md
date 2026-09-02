# 招标分析结构化成果

结构化文件使用 UTF-8 JSON。字段无法确认时写 `null`，并在 `status` 或 `openQuestions` 中说明原因，禁止猜测。

## project-facts.json

```json
{
  "schemaVersion": 1,
  "project": {
    "name": "项目名称",
    "location": "建设地点",
    "durationDays": 365,
    "qualityTarget": "质量目标",
    "scope": ["施工范围"],
    "majorQuantities": [{ "item": "道路", "quantity": 617, "unit": "m" }]
  },
  "evidence": {
    "project.name": [{ "source": "招标文件.pdf", "location": "第1页/招标公告" }]
  },
  "conflicts": [],
  "openQuestions": []
}
```

项目字段包括已确认事实，不在一个字符串中混入判断。`evidence` 的键使用字段路径；已确认的关键字段必须至少有一条证据。

## scoring-matrix.json

```json
{
  "schemaVersion": 1,
  "items": [
    {
      "id": "S01",
      "title": "施工总体部署",
      "maxScore": 10,
      "mandatory": false,
      "requirements": ["施工分区", "总体流程", "专业穿插"],
      "sourceRef": "招标文件.pdf 第三章 评标办法"
    }
  ],
  "rejectionRisks": [
    {
      "id": "R01",
      "rule": "暗标不得出现投标人标识",
      "sourceRef": "招标文件.pdf 投标人须知"
    }
  ]
}
```

`maxScore` 仅抄录招标文件明示分值。无法确认时写 `null`，不得推算隐藏权重。

## requirement-traceability.json

```json
{
  "schemaVersion": 1,
  "requirements": [
    {
      "id": "S01-01",
      "parentId": "S01",
      "type": "scoring",
      "requirement": "说明施工分区",
      "sourceRef": "招标文件.pdf 第三章",
      "plannedSection": "第三章 施工总体部署",
      "status": "planned"
    }
  ]
}
```

`type` 只能使用 `rejection`、`mandatory`、`scoring`、`contract`、`format`。交付分析报告时同时列出资料清单、版本优先级、冲突和待确认问题。
