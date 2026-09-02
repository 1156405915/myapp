import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function readArguments(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || !value) throw new Error(`无效参数：${key || ''}`)
    values[key.slice(2)] = value
  }
  for (const required of ['facts', 'matrix', 'plan']) {
    if (!values[required]) throw new Error(`缺少 --${required} 参数`)
  }
  return values
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'))
}

function stableValue(value) {
  if (value === undefined || value === null || value === '') return null
  return typeof value === 'string' ? value.trim() : value
}

export function checkConsistency(facts, matrix, plan) {
  const issues = []
  const addIssue = (severity, code, message, details = {}) => {
    issues.push({
      id: `CONS-${String(issues.length + 1).padStart(3, '0')}`,
      severity,
      code,
      message,
      ...details
    })
  }

  const factProject = facts?.project
  const planProject = plan?.project
  if (!factProject || typeof factProject !== 'object') {
    addIssue('blocking', 'facts-project-missing', 'project-facts.json 缺少 project 对象')
  }
  if (!planProject || typeof planProject !== 'object') {
    addIssue('blocking', 'plan-project-missing', 'construction-plan.json 缺少 project 对象')
  }
  if (!Array.isArray(matrix?.items)) {
    addIssue('blocking', 'matrix-items-missing', 'scoring-matrix.json 缺少 items 数组')
  }
  if (!Array.isArray(plan?.responses)) {
    addIssue('blocking', 'plan-responses-missing', 'construction-plan.json 缺少 responses 数组')
  }

  const keyFields = ['name', 'location', 'durationDays', 'qualityTarget']
  for (const field of keyFields) {
    const factValue = stableValue(factProject?.[field])
    const planValue = stableValue(planProject?.[field])
    if (factValue === null) {
      addIssue('high', 'key-fact-missing', `项目关键事实缺失：project.${field}`, { field })
    } else if (
      !Array.isArray(facts?.evidence?.[`project.${field}`]) ||
      !facts.evidence[`project.${field}`].length
    ) {
      addIssue(
        'medium',
        'key-fact-evidence-missing',
        `项目关键事实缺少来源证据：project.${field}`,
        { field }
      )
    }
    if (factValue !== null && planValue !== null && factValue !== planValue) {
      addIssue('high', 'project-value-mismatch', `施组计划与项目事实不一致：project.${field}`, {
        field,
        expected: factValue,
        actual: planValue
      })
    }
  }

  const factDuration = stableValue(factProject?.durationDays)
  const scheduleDuration = stableValue(plan?.schedule?.totalDurationDays)
  if (factDuration !== null && scheduleDuration !== null && factDuration !== scheduleDuration) {
    addIssue('high', 'schedule-duration-mismatch', '进度计划总工期与招标工期不一致', {
      expected: factDuration,
      actual: scheduleDuration
    })
  }

  const items = Array.isArray(matrix?.items) ? matrix.items : []
  const responses = Array.isArray(plan?.responses) ? plan.responses : []
  const itemIds = new Set()
  for (const item of items) {
    const id = stableValue(item?.id)
    if (!id) {
      addIssue('high', 'scoring-id-missing', '评分项缺少 id')
      continue
    }
    if (itemIds.has(id))
      addIssue('high', 'scoring-id-duplicate', `评分项 id 重复：${id}`, { scoringItemId: id })
    itemIds.add(id)
    if (!stableValue(item?.title))
      addIssue('high', 'scoring-title-missing', `评分项 ${id} 缺少标题`, { scoringItemId: id })
    if (!stableValue(item?.sourceRef))
      addIssue('medium', 'scoring-source-missing', `评分项 ${id} 缺少招标文件来源`, {
        scoringItemId: id
      })
  }

  const responseIds = new Set()
  for (const response of responses) {
    const id = stableValue(response?.scoringItemId)
    if (!id) {
      addIssue('high', 'response-id-missing', '评分响应缺少 scoringItemId')
      continue
    }
    if (!itemIds.has(id))
      addIssue('high', 'response-id-unknown', `响应引用了不存在的评分项：${id}`, {
        scoringItemId: id
      })
    responseIds.add(id)
    if (!Array.isArray(response?.sections) || !response.sections.length) {
      addIssue('high', 'response-section-missing', `评分项 ${id} 未绑定正文位置`, {
        scoringItemId: id
      })
    }
    if (!Array.isArray(response?.evidenceRefs) || !response.evidenceRefs.length) {
      addIssue('medium', 'response-evidence-missing', `评分项 ${id} 缺少图表或记录证据`, {
        scoringItemId: id
      })
    }
  }
  for (const id of itemIds) {
    if (!responseIds.has(id))
      addIssue('high', 'scoring-item-uncovered', `评分项未响应：${id}`, { scoringItemId: id })
  }

  const counts = { blocking: 0, high: 0, medium: 0, low: 0 }
  for (const issue of issues) counts[issue.severity] += 1
  return {
    schemaVersion: 1,
    checkType: 'mayi-construction-consistency',
    ready: counts.blocking === 0 && counts.high === 0,
    summary: {
      ...counts,
      scoringItems: itemIds.size,
      coveredScoringItems: [...itemIds].filter((id) => responseIds.has(id)).length
    },
    issues
  }
}

function main() {
  try {
    const args = readArguments(process.argv.slice(2))
    const report = checkConsistency(
      readJson(args.facts),
      readJson(args.matrix),
      readJson(args.plan)
    )
    const json = `${JSON.stringify(report, null, 2)}\n`
    if (args.output) writeFileSync(resolve(args.output), json, 'utf8')
    else process.stdout.write(json)
    process.exitCode = report.ready ? 0 : 2
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
}
