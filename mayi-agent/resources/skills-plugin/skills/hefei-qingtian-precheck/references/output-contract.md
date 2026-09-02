# 预审输出契约

生成 `qingtian-precheck-report.json` 和一份面向用户的中文报告。

```json
{
  "schemaVersion": 1,
  "reviewType": "mayi-hefei-qingtian-readiness",
  "officialAssessment": false,
  "status": "needs-revision",
  "scope": {
    "documents": ["施工组织设计.docx"],
    "tenderVersion": "最终补疑后版本",
    "limitations": []
  },
  "summary": {
    "blocking": 0,
    "high": 2,
    "medium": 3,
    "low": 1,
    "scoringCoverage": { "covered": 7, "total": 8 }
  },
  "issues": [
    {
      "id": "QT-001",
      "severity": "high",
      "dimension": "scoring-coverage",
      "location": "评分项S08",
      "evidence": "未找到施工总平面布置图",
      "impact": "评分要求缺少直接证据",
      "action": "补充总平面图并在正文引用",
      "verification": "追踪表S08状态变更为covered"
    }
  ]
}
```

`status` 只能为：

- `ready`：没有阻断或高风险，评分项全部覆盖。
- `needs-revision`：存在可修复问题。
- `insufficient-input`：缺少招标文件、最终补疑或完整技术标等关键材料。

中文报告先列结论和最高风险，再列评分覆盖、问题台账、修订顺序、无法验证事项和复核结果。不得提供官方分数预测。
