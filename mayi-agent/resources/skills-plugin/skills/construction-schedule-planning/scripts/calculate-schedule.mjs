import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const RELATION_TYPES = new Set(['FS', 'SS', 'FF', 'SF'])
const EPSILON = 1e-9
const MAX_CRITICAL_PATHS = 100

function parseArguments(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) throw new Error(`无效参数：${key || ''}`)
    values[key.slice(2)] = value
  }
  for (const required of ['plan', 'output']) {
    if (!values[required]) throw new Error(`缺少 --${required} 参数`)
  }
  return values
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temporaryPath, path)
}

function asFiniteNumber(value) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : null
}

function round(value, digits = 6) {
  const factor = 10 ** digits
  return Math.round((value + Number.EPSILON) * factor) / factor
}

function normalizeRelationship(value) {
  if (typeof value === 'string') return { id: value.trim(), type: 'FS', lagDays: 0 }
  if (!value || typeof value !== 'object') return null
  const id = typeof value.id === 'string' ? value.id.trim() : ''
  const type = typeof value.type === 'string' ? value.type.trim().toUpperCase() : 'FS'
  const lagDays = asFiniteNumber(value.lagDays ?? 0)
  if (!id || !RELATION_TYPES.has(type) || lagDays === null) return null
  return { id, type, lagDays }
}

function deriveDuration(task) {
  const explicit = asFiniteNumber(task.durationDays)
  if (explicit !== null) {
    if (explicit > 0 || (task.milestone === true && explicit === 0)) {
      return { durationDays: explicit, source: 'explicit', formula: null }
    }
    return null
  }
  const quantity = asFiniteNumber(task.quantity)
  const productivity = asFiniteNumber(task.productivityPerCrewDay)
  const crews = asFiniteNumber(task.crews)
  if (quantity === null || productivity === null || crews === null || quantity <= 0 || productivity <= 0 || crews <= 0) return null
  const durationDays = Math.ceil(quantity / (productivity * crews))
  return {
    durationDays,
    source: 'derived',
    formula: {
      expression: 'ceil(quantity / (productivityPerCrewDay * crews))',
      quantity,
      quantityUnit: task.quantityUnit || null,
      productivityPerCrewDay: productivity,
      crews
    }
  }
}

function relationshipOffset(predecessor, successor, relationship) {
  if (relationship.type === 'FS') return predecessor.durationDays + relationship.lagDays
  if (relationship.type === 'SS') return relationship.lagDays
  if (relationship.type === 'FF') return predecessor.durationDays - successor.durationDays + relationship.lagDays
  return -successor.durationDays + relationship.lagDays
}

function normalizeEquipment(values) {
  if (!Array.isArray(values)) return []
  const equipment = []
  for (const value of values) {
    if (typeof value === 'string') {
      const text = value.trim()
      if (!text) continue
      const match = text.match(/^(.+?)(\d+(?:\.\d+)?)\s*(?:台|套|辆|部)?$/u)
      equipment.push({ name: match ? match[1].trim() : text, count: match ? Number(match[2]) : 1 })
      continue
    }
    if (!value || typeof value !== 'object' || typeof value.name !== 'string') continue
    const count = asFiniteNumber(value.count)
    if (value.name.trim() && count !== null && count > 0) equipment.push({ name: value.name.trim(), count })
  }
  return equipment
}

function normalizeMaterials(values) {
  if (!Array.isArray(values)) return []
  return values.flatMap((value) => {
    if (!value || typeof value !== 'object' || typeof value.name !== 'string') return []
    const quantity = asFiniteNumber(value.quantity)
    if (!value.name.trim() || quantity === null || quantity < 0) return []
    return [{ name: value.name.trim(), quantity, unit: typeof value.unit === 'string' ? value.unit.trim() : null }]
  })
}

function createIssueCollector() {
  const issues = []
  return {
    issues,
    add(severity, code, message, details = {}) {
      issues.push({ id: `PLAN-${String(issues.length + 1).padStart(3, '0')}`, severity, code, message, ...details })
    }
  }
}

function prepareTasks(plan, collector) {
  if (!Array.isArray(plan?.wbs) || plan.wbs.length === 0) {
    collector.add('blocking', 'wbs-missing', 'construction-plan.json 缺少非空 wbs 数组')
    return { tasks: [], taskMap: new Map() }
  }
  const tasks = []
  const taskMap = new Map()
  for (const sourceTask of plan.wbs) {
    const id = typeof sourceTask?.id === 'string' ? sourceTask.id.trim() : ''
    if (!id) {
      collector.add('blocking', 'task-id-missing', 'WBS 任务缺少 id')
      continue
    }
    if (taskMap.has(id)) {
      collector.add('blocking', 'task-id-duplicate', `WBS 任务 id 重复：${id}`, { taskId: id })
      continue
    }
    const duration = deriveDuration(sourceTask)
    if (!duration) {
      collector.add('blocking', 'task-duration-invalid', `任务 ${id} 缺少有效工期或产能推算参数`, { taskId: id })
      continue
    }
    const relationships = []
    for (const value of Array.isArray(sourceTask.predecessors) ? sourceTask.predecessors : []) {
      const relationship = normalizeRelationship(value)
      if (!relationship) {
        collector.add('blocking', 'relationship-invalid', `任务 ${id} 存在无效前置关系`, { taskId: id, relationship: value })
      } else {
        relationships.push(relationship)
      }
    }
    const task = {
      source: sourceTask,
      id,
      name: typeof sourceTask.name === 'string' && sourceTask.name.trim() ? sourceTask.name.trim() : id,
      durationDays: duration.durationDays,
      durationSource: duration.source,
      durationFormula: duration.formula,
      relationships,
      successors: [],
      labor: Math.max(0, asFiniteNumber(sourceTask.labor) ?? 0),
      equipment: normalizeEquipment(sourceTask.equipment),
      materials: normalizeMaterials(sourceTask.materials),
      earlyStart: 0,
      earlyFinish: 0,
      lateStart: 0,
      lateFinish: 0,
      totalFloat: 0,
      freeFloat: 0,
      drivingPredecessors: []
    }
    tasks.push(task)
    taskMap.set(id, task)
  }
  for (const task of tasks) {
    const unique = new Set()
    task.relationships = task.relationships.filter((relationship) => {
      const key = `${relationship.id}|${relationship.type}|${relationship.lagDays}`
      if (unique.has(key)) return false
      unique.add(key)
      const predecessor = taskMap.get(relationship.id)
      if (!predecessor) {
        collector.add('blocking', 'predecessor-unknown', `任务 ${task.id} 引用了不存在的前置任务 ${relationship.id}`, { taskId: task.id, predecessorId: relationship.id })
        return false
      }
      if (predecessor.id === task.id) {
        collector.add('blocking', 'predecessor-self', `任务 ${task.id} 不能依赖自身`, { taskId: task.id })
        return false
      }
      predecessor.successors.push({ taskId: task.id, relationship })
      return true
    })
  }
  return { tasks, taskMap }
}

function topologicalSort(tasks, taskMap, collector) {
  const indegrees = new Map(tasks.map((task) => [task.id, 0]))
  for (const task of tasks) {
    for (const relationship of task.relationships) {
      if (taskMap.has(relationship.id)) indegrees.set(task.id, (indegrees.get(task.id) || 0) + 1)
    }
  }
  const queue = tasks.filter((task) => indegrees.get(task.id) === 0).sort((left, right) => left.id.localeCompare(right.id))
  const ordered = []
  while (queue.length) {
    const task = queue.shift()
    ordered.push(task)
    for (const successor of task.successors) {
      const next = (indegrees.get(successor.taskId) || 0) - 1
      indegrees.set(successor.taskId, next)
      if (next === 0) {
        queue.push(taskMap.get(successor.taskId))
        queue.sort((left, right) => left.id.localeCompare(right.id))
      }
    }
  }
  if (ordered.length !== tasks.length) {
    const cycleTasks = tasks.filter((task) => !ordered.includes(task)).map((task) => task.id)
    collector.add('blocking', 'wbs-cycle', `WBS 前置关系存在环路：${cycleTasks.join('、')}`, { taskIds: cycleTasks })
    return null
  }
  return ordered
}

function calculateCpm(ordered, taskMap) {
  for (const task of ordered) {
    let earlyStart = 0
    const candidates = []
    for (const relationship of task.relationships) {
      const predecessor = taskMap.get(relationship.id)
      const value = predecessor.earlyStart + relationshipOffset(predecessor, task, relationship)
      candidates.push({ taskId: predecessor.id, value })
      earlyStart = Math.max(earlyStart, value)
    }
    task.earlyStart = earlyStart
    task.earlyFinish = earlyStart + task.durationDays
    task.drivingPredecessors = candidates
      .filter((candidate) => Math.abs(candidate.value - earlyStart) <= EPSILON)
      .map((candidate) => candidate.taskId)
  }
  const projectDuration = Math.max(0, ...ordered.map((task) => task.earlyFinish))
  for (const task of ordered) {
    task.lateStart = projectDuration - task.durationDays
    task.lateFinish = projectDuration
  }
  for (const task of [...ordered].reverse()) {
    for (const successorLink of task.successors) {
      const successor = taskMap.get(successorLink.taskId)
      const offset = relationshipOffset(task, successor, successorLink.relationship)
      task.lateStart = Math.min(task.lateStart, successor.lateStart - offset)
    }
    task.lateFinish = task.lateStart + task.durationDays
    task.totalFloat = Math.max(0, task.lateStart - task.earlyStart)
    const edgeFloats = task.successors.map((successorLink) => {
      const successor = taskMap.get(successorLink.taskId)
      return successor.earlyStart - (task.earlyStart + relationshipOffset(task, successor, successorLink.relationship))
    })
    task.freeFloat = Math.max(0, edgeFloats.length ? Math.min(...edgeFloats) : projectDuration - task.earlyFinish)
  }
  return projectDuration
}

function enumerateCriticalPaths(ordered, taskMap, projectDuration, collector) {
  const criticalIds = new Set(ordered.filter((task) => task.totalFloat <= EPSILON).map((task) => task.id))
  const criticalSuccessors = new Map([...criticalIds].map((id) => [id, []]))
  const criticalPredecessorCounts = new Map([...criticalIds].map((id) => [id, 0]))
  for (const task of ordered) {
    if (!criticalIds.has(task.id)) continue
    for (const successorLink of task.successors) {
      const successor = taskMap.get(successorLink.taskId)
      if (!criticalIds.has(successor.id)) continue
      const expectedStart = task.earlyStart + relationshipOffset(task, successor, successorLink.relationship)
      if (Math.abs(successor.earlyStart - expectedStart) > EPSILON) continue
      criticalSuccessors.get(task.id).push(successor.id)
      criticalPredecessorCounts.set(successor.id, (criticalPredecessorCounts.get(successor.id) || 0) + 1)
    }
  }
  const roots = ordered
    .filter((task) => criticalIds.has(task.id) && criticalPredecessorCounts.get(task.id) === 0)
    .map((task) => task.id)
  const paths = []
  let truncated = false
  function visit(taskId, path) {
    if (paths.length >= MAX_CRITICAL_PATHS) {
      truncated = true
      return
    }
    const successors = criticalSuccessors.get(taskId) || []
    const task = taskMap.get(taskId)
    if (!successors.length) {
      if (Math.abs(task.earlyFinish - projectDuration) <= EPSILON) paths.push([...path, taskId])
      return
    }
    for (const successorId of successors) visit(successorId, [...path, taskId])
  }
  for (const rootId of roots) visit(rootId, [])
  if (truncated) collector.add('medium', 'critical-paths-truncated', `关键线路超过 ${MAX_CRITICAL_PATHS} 条，报告已截断`)
  return { criticalTaskIds: [...criticalIds], criticalPaths: paths, truncated }
}

function calculateResources(ordered, plan, collector) {
  const timeline = new Map()
  const equipmentPeaks = new Map()
  const ensureDay = (dayIndex) => {
    if (!timeline.has(dayIndex)) timeline.set(dayIndex, { day: dayIndex + 1, labor: 0, equipment: {}, materials: {}, activeTaskIds: [] })
    return timeline.get(dayIndex)
  }
  for (const task of ordered) {
    if (task.durationDays <= 0) continue
    const start = Math.floor(task.earlyStart)
    const end = Math.ceil(task.earlyFinish)
    for (let dayIndex = start; dayIndex < end; dayIndex += 1) {
      const day = ensureDay(dayIndex)
      day.activeTaskIds.push(task.id)
      day.labor += task.labor
      for (const item of task.equipment) day.equipment[item.name] = (day.equipment[item.name] || 0) + item.count
      for (const item of task.materials) {
        const key = `${item.name}|${item.unit || ''}`
        day.materials[key] = (day.materials[key] || 0) + item.quantity / task.durationDays
      }
    }
  }
  const rows = [...timeline.values()].sort((left, right) => left.day - right.day)
  for (const row of rows) {
    row.labor = round(row.labor)
    row.activeTaskIds.sort()
    row.equipment = Object.fromEntries(Object.entries(row.equipment).sort(([left], [right]) => left.localeCompare(right, 'zh-CN')).map(([name, count]) => [name, round(count)]))
    row.materials = Object.fromEntries(Object.entries(row.materials).sort(([left], [right]) => left.localeCompare(right, 'zh-CN')).map(([key, quantity]) => [key, round(quantity)]))
    for (const [name, count] of Object.entries(row.equipment)) equipmentPeaks.set(name, Math.max(equipmentPeaks.get(name) || 0, count))
  }
  const laborPeak = Math.max(0, ...rows.map((row) => row.labor))
  const limits = plan?.resourceLimits
  const laborLimit = asFiniteNumber(limits?.labor)
  if (laborLimit !== null && laborLimit >= 0 && laborPeak > laborLimit) {
    collector.add('high', 'labor-limit-exceeded', `劳动力峰值 ${laborPeak} 超过限制 ${laborLimit}`, { peak: laborPeak, limit: laborLimit })
  }
  if (limits?.equipment && typeof limits.equipment === 'object') {
    for (const [name, value] of Object.entries(limits.equipment)) {
      const limit = asFiniteNumber(value)
      const peak = equipmentPeaks.get(name) || 0
      if (limit !== null && limit >= 0 && peak > limit) collector.add('high', 'equipment-limit-exceeded', `${name}峰值 ${peak} 超过限制 ${limit}`, { equipment: name, peak, limit })
    }
  }
  return {
    timeline: rows,
    peaks: {
      labor: laborPeak,
      equipment: Object.fromEntries([...equipmentPeaks.entries()].sort(([left], [right]) => left.localeCompare(right, 'zh-CN')))
    }
  }
}

export function calculateSchedule(plan) {
  const collector = createIssueCollector()
  const { tasks, taskMap } = prepareTasks(plan, collector)
  const ordered = topologicalSort(tasks, taskMap, collector)
  let projectDuration = null
  let critical = { criticalTaskIds: [], criticalPaths: [], truncated: false }
  let resources = { timeline: [], peaks: { labor: 0, equipment: {} } }
  if (ordered && !collector.issues.some((issue) => issue.severity === 'blocking')) {
    projectDuration = calculateCpm(ordered, taskMap)
    critical = enumerateCriticalPaths(ordered, taskMap, projectDuration, collector)
    resources = calculateResources(ordered, plan, collector)
    const targetDuration = asFiniteNumber(plan?.project?.durationDays)
    if (targetDuration !== null && targetDuration > 0 && projectDuration > targetDuration + EPSILON) {
      collector.add('high', 'target-duration-exceeded', `计算工期 ${projectDuration} 天超过目标工期 ${targetDuration} 天`, { calculatedDurationDays: projectDuration, targetDurationDays: targetDuration, varianceDays: round(projectDuration - targetDuration) })
    }
    for (const milestone of Array.isArray(plan?.schedule?.milestones) ? plan.schedule.milestones : []) {
      const day = asFiniteNumber(milestone?.day)
      if (day !== null && day > projectDuration) collector.add('medium', 'milestone-outside-network', `里程碑“${milestone.name || '未命名'}”位于计算工期之外`, { milestone: milestone.name || null, day, calculatedDurationDays: projectDuration })
    }
  }
  const counts = { blocking: 0, high: 0, medium: 0, low: 0 }
  for (const issue of collector.issues) counts[issue.severity] += 1
  const generatedAt = new Date().toISOString()
  const taskResults = (ordered || tasks).map((task) => ({
    id: task.id,
    name: task.name,
    durationDays: task.durationDays,
    durationSource: task.durationSource,
    durationFormula: task.durationFormula,
    startDay: projectDuration === null ? null : round(task.earlyStart + 1),
    finishDay: projectDuration === null ? null : round(task.earlyFinish),
    earlyStart: projectDuration === null ? null : round(task.earlyStart),
    earlyFinish: projectDuration === null ? null : round(task.earlyFinish),
    lateStart: projectDuration === null ? null : round(task.lateStart),
    lateFinish: projectDuration === null ? null : round(task.lateFinish),
    totalFloatDays: projectDuration === null ? null : round(task.totalFloat),
    freeFloatDays: projectDuration === null ? null : round(task.freeFloat),
    critical: projectDuration !== null && task.totalFloat <= EPSILON,
    drivingPredecessors: task.drivingPredecessors
  }))
  return {
    schemaVersion: 1,
    calculationType: 'mayi-construction-cpm',
    generatedAt,
    ready: counts.blocking === 0 && counts.high === 0,
    calendar: 'continuous-calendar-days',
    targetDurationDays: asFiniteNumber(plan?.project?.durationDays),
    calculatedDurationDays: projectDuration === null ? null : round(projectDuration),
    varianceDays: projectDuration === null || asFiniteNumber(plan?.project?.durationDays) === null ? null : round(projectDuration - Number(plan.project.durationDays)),
    summary: { ...counts, taskCount: tasks.length, criticalTaskCount: critical.criticalTaskIds.length, criticalPathCount: critical.criticalPaths.length },
    tasks: taskResults,
    criticalTaskIds: critical.criticalTaskIds,
    criticalPaths: critical.criticalPaths,
    resourcePeaks: resources.peaks,
    resourceTimeline: resources.timeline,
    issues: collector.issues
  }
}

export function enrichPlan(plan, report) {
  const taskResults = new Map(report.tasks.map((task) => [task.id, task]))
  return {
    ...plan,
    wbs: Array.isArray(plan.wbs)
      ? plan.wbs.map((task) => {
          const calculation = taskResults.get(task.id)
          return calculation ? { ...task, calculation } : task
        })
      : plan.wbs,
    schedule: {
      ...(plan.schedule || {}),
      targetDurationDays: report.targetDurationDays,
      calculatedDurationDays: report.calculatedDurationDays,
      criticalPath: report.criticalPaths[0] || [],
      criticalPaths: report.criticalPaths,
      resourcePeaks: report.resourcePeaks,
      calendar: report.calendar,
      calculatedAt: report.generatedAt
    }
  }
}

async function main() {
  try {
    const args = parseArguments(process.argv.slice(2))
    const planPath = resolve(args.plan)
    if (!existsSync(planPath)) throw new Error('construction-plan.json 不存在')
    const plan = JSON.parse(readFileSync(planPath, 'utf8'))
    const report = calculateSchedule(plan)
    writeJsonAtomic(resolve(args.output), report)
    if (args['enriched-plan']) writeJsonAtomic(resolve(args['enriched-plan']), enrichPlan(plan, report))
    process.stdout.write(`${JSON.stringify({ ready: report.ready, calculatedDurationDays: report.calculatedDurationDays, criticalPathCount: report.summary.criticalPathCount, issues: report.summary }, null, 2)}\n`)
    process.exitCode = report.ready ? 0 : 2
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main()
}
