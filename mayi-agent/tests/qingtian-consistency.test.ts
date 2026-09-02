import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const temporaryDirectories: string[] = []
const scriptPath = resolve(
  'resources/skills-plugin/skills/hefei-qingtian-precheck/scripts/check-consistency.mjs'
)

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function runCheck(overrides: { plan?: Record<string, unknown> } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'mayi-qingtian-check-'))
  temporaryDirectories.push(directory)
  const factsPath = join(directory, 'project-facts.json')
  const matrixPath = join(directory, 'scoring-matrix.json')
  const planPath = join(directory, 'construction-plan.json')
  const outputPath = join(directory, 'consistency-report.json')
  const project = {
    name: '测试道路工程',
    location: '安徽省合肥市',
    durationDays: 365,
    qualityTarget: '合格'
  }
  writeFileSync(
    factsPath,
    JSON.stringify({
      project,
      evidence: Object.fromEntries(
        Object.keys(project).map((field) => [
          `project.${field}`,
          [{ source: '招标文件.pdf', location: '投标人须知' }]
        ])
      )
    }),
    'utf8'
  )
  writeFileSync(
    matrixPath,
    JSON.stringify({ items: [{ id: 'S01', title: '施工总体部署', sourceRef: '评标办法' }] }),
    'utf8'
  )
  writeFileSync(
    planPath,
    JSON.stringify({
      project,
      schedule: { totalDurationDays: 365 },
      responses: [
        {
          scoringItemId: 'S01',
          sections: ['第三章 施工总体部署'],
          evidenceRefs: ['图3-1 总体施工流程']
        }
      ],
      ...overrides.plan
    }),
    'utf8'
  )

  const result = spawnSync(
    process.execPath,
    [
      scriptPath,
      '--facts',
      factsPath,
      '--matrix',
      matrixPath,
      '--plan',
      planPath,
      '--output',
      outputPath
    ],
    { encoding: 'utf8' }
  )
  const report = JSON.parse(readFileSync(outputPath, 'utf8')) as {
    ready: boolean
    issues: Array<{ code: string }>
  }
  return { result, report }
}

describe('合肥青天适配预审一致性检查', () => {
  it('结构化事实、计划和评分响应一致时通过', () => {
    const { result, report } = runCheck()
    expect(result.status).toBe(0)
    expect(report.ready).toBe(true)
    expect(report.issues).toEqual([])
  })

  it('识别工期矛盾和未覆盖评分项', () => {
    const { result, report } = runCheck({
      plan: { schedule: { totalDurationDays: 300 }, responses: [] }
    })
    expect(result.status).toBe(2)
    expect(report.ready).toBe(false)
    expect(report.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['schedule-duration-mismatch', 'scoring-item-uncovered'])
    )
  })
})
