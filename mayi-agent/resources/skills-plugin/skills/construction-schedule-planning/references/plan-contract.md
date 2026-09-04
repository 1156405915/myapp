# 施工计划输入契约

## WBS 任务

```json
{
  "id": "W01",
  "name": "施工准备",
  "zoneId": "Z01",
  "durationDays": 5,
  "predecessors": [
    "W00",
    { "id": "W00", "type": "FS", "lagDays": 0 }
  ],
  "labor": 20,
  "equipment": [
    "挖掘机2台",
    { "name": "压路机", "count": 1 }
  ],
  "materials": [
    { "name": "水泥稳定碎石", "quantity": 1200, "unit": "t" }
  ]
}
```

`durationDays` 缺失时可以使用以下字段推算：

```json
{
  "quantity": 1200,
  "quantityUnit": "m",
  "productivityPerCrewDay": 80,
  "crews": 2
}
```

计算公式：

```text
durationDays = ceil(quantity / (productivityPerCrewDay × crews))
```

## 关系类型

- `FS`：前置任务完成后开始。
- `SS`：前置任务开始后开始。
- `FF`：前置任务完成后完成。
- `SF`：前置任务开始后完成。
- `lagDays`：正数表示等待，负数表示搭接。

## 资源限制

```json
{
  "resourceLimits": {
    "labor": 100,
    "equipment": {
      "挖掘机": 4,
      "压路机": 2
    }
  }
}
```

超过限制时生成高风险问题，不自动修改任务工期或资源数量。

## 输出原则

- 时间计算内部以第 0 天起算，报告中的 `startDay` 使用第 1 天起算。
- `finishDay` 表示任务占用的最后一个日历日。
- `totalFloatDays` 为 0 的任务是关键任务。
- 存在多条关键线路时全部输出，最多保留 100 条，超过时生成警告。
- 计算结果必须保留任务原始工期或推算公式，不删除输入数据。
