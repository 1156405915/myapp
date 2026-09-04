import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const temporaryDirectories: string[] = []
const scriptPath = resolve(
  'resources/skills-plugin/skills/construction-schedule-planning/scripts/calculate-schedule.mjs'
)

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'mayi-construction-schedule-'))
  temporaryDirectories.push(directory)
  return directory
}

function runSchedule(plan: Record<string, unknown>) {
  const directory = createTemporaryDirectory()
  const planPath = join(directory, 'construction-plan.json')
  const outputPath = join(directory, 'schedule-calculation.json')
  const enrichedPath = join(directory, 'construction-plan.calculated.json')
  writeFileSync(planPath, JSON.stringify(plan), 'utf8')
  const execution = spawnSync(
    process.execPath,
    [scriptPath, '--plan', planPath, '--output', outputPath, '--enriched-plan', enrichedPath],
    { encoding: 'utf8' }
  )
  return {
    execution,
    report: JSON.parse(readFileSync(outputPath, 'utf8')),
    enriched: JSON.parse(readFileSync(enrichedPath, 'utf8'))
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('construction schedule planning', () => {
  it('计算关键线路、时差和资源峰值', () => {
    const { execution, report, enriched } = runSchedule({
      project: { durationDays: 10 },
      resourceLimits: { labor: 20, equipment: { 挖掘机: 2 } },
      wbs: [
        { id: 'A', name: '准备', durationDays: 2, predecessors: [], labor: 5 },
        { id: 'B', name: '主线', durationDays: 3, predecessors: ['A'], labor: 10, equipment: ['挖掘机2台'] },
        { id: 'C', name: '支线', durationDays: 1, predecessors: ['A'], labor: 4 },
        { id: 'D', name: '收尾', durationDays: 2, predecessors: ['B', 'C'], labor: 6 }
      ]
    })

    expect(execution.status).toBe(0)
    expect(report.ready).toBe(true)
    expect(report.calculatedDurationDays).toBe(7)
    expect(report.criticalPaths).toEqual([['A', 'B', 'D']])
    expect(report.tasks.find((task) => task.id === 'C').totalFloatDays).toBe(2)
    expect(report.resourcePeaks.labor).toBe(14)
    expect(report.resourcePeaks.equipment).toEqual({ 挖掘机: 2 })
    expect(enriched.schedule.calculatedDurationDays).toBe(7)
    expect(enriched.schedule.criticalPath).toEqual(['A', 'B', 'D'])
  })

  it('根据工程量和产能推算工期并报告资源超限', () => {
    const { execution, report } = runSchedule({
      project: { durationDays: 4 },
      resourceLimits: { labor: 8 },
      wbs: [
        {
          id: 'A',
          name: '管道施工',
          quantity: 1000,
          quantityUnit: 'm',
          productivityPerCrewDay: 100,
          crews: 2,
          predecessors: [],
          labor: 10
        }
      ]
    })

    expect(execution.status).toBe(2)
    expect(report.calculatedDurationDays).toBe(5)
    expect(report.tasks[0].durationSource).toBe('derived')
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'target-duration-exceeded', severity: 'high' }),
        expect.objectContaining({ code: 'labor-limit-exceeded', severity: 'high' })
      ])
    )
  })

  it('拒绝未知前置任务和WBS环路', () => {
    const unknown = runSchedule({
      project: { durationDays: 10 },
      wbs: [{ id: 'A', durationDays: 1, predecessors: ['UNKNOWN'] }]
    })
    expect(unknown.execution.status).toBe(2)
    expect(unknown.report.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'predecessor-unknown', severity: 'blocking' })])
    )

    const cycle = runSchedule({
      project: { durationDays: 10 },
      wbs: [
        { id: 'A', durationDays: 1, predecessors: ['B'] },
        { id: 'B', durationDays: 1, predecessors: ['A'] }
      ]
    })
    expect(cycle.execution.status).toBe(2)
    expect(cycle.report.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'wbs-cycle', severity: 'blocking' })])
    )
  })
})
