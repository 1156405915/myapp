import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const temporaryDirectories: string[] = []
const scriptPath = resolve(
  'resources/skills-plugin/skills/construction-intake/scripts/inventory.mjs'
)

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'mayi-construction-intake-'))
  temporaryDirectories.push(directory)
  return directory
}

function writePdf(path: string, content = 'test'): void {
  writeFileSync(path, `%PDF-1.4\n${content}\n%%EOF`, 'utf8')
}

function runInventory(input: string, output: string) {
  const args = [scriptPath, '--input', input, '--output', output]
  return spawnSync(process.execPath, args, { encoding: 'utf8' })
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('construction-intake inventory', () => {
  it('分类、哈希并识别重复文件和基础完整性', async () => {
    const root = createTemporaryDirectory()
    const output = join(root, '.mayi', 'tasks', 'session', 'construction-plan', '00-intake')
    mkdirSync(join(root, '图纸'), { recursive: true })
    mkdirSync(join(root, '工程量清单'), { recursive: true })
    writePdf(join(root, '招标文件正文.pdf'), 'tender')
    writePdf(join(root, '招标文件正文副本.pdf'), 'tender')
    writePdf(join(root, '项目补疑2.pdf'), 'clarification')
    writePdf(join(root, '图纸', '道路施工图.pdf'), 'drawing')
    writeFileSync(join(root, '工程量清单', '道路工程.xlsx'), Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    writeFileSync(join(root, '图纸', '~$道路说明.docx'), 'lock')
    writeFileSync(join(root, '空文件.txt'), '')

    const execution = runInventory(root, output)
    const inventory = JSON.parse(readFileSync(join(output, 'file-inventory.json'), 'utf8'))
    const sourceRegister = JSON.parse(readFileSync(join(output, 'source-register.json'), 'utf8'))
    const unreadableFiles = JSON.parse(readFileSync(join(output, 'unreadable-files.json'), 'utf8'))
    const completeness = JSON.parse(readFileSync(join(output, 'completeness-report.json'), 'utf8'))

    expect(execution.status).toBe(2)
    expect(inventory.summary.fileCount).toBe(7)
    expect(inventory.files.find((file) => file.name === '招标文件正文.pdf')?.category).toBe('tender')
    expect(inventory.files.find((file) => file.name === '项目补疑2.pdf')?.category).toBe('clarification')
    expect(sourceRegister.duplicateGroups).toHaveLength(1)
    expect(completeness.status).toBe('blocked')
    expect(unreadableFiles.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'empty-file', relativePath: '空文件.txt' })])
    )
    expect(unreadableFiles.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'office-lock-file', severity: 'low' })])
    )
    expect(unreadableFiles.issues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relativePath: '图纸/~$道路说明.docx', code: 'signature-not-recognized' })
      ])
    )
    for (const fileName of [
      'file-inventory.json',
      'source-register.json',
      'unreadable-files.json',
      'completeness-report.json',
      'change-summary.json'
    ]) {
      expect(() => JSON.parse(readFileSync(join(output, fileName), 'utf8'))).not.toThrow()
    }
  })

  it('报告四阶段输入影响但不改写旧任务状态', async () => {
    const root = createTemporaryDirectory()
    const planRoot = join(root, '.mayi', 'tasks', 'session', 'construction-plan')
    const output = join(planRoot, '00-intake')
    const taskState = join(planRoot, 'task-state.json')
    mkdirSync(join(root, '图纸'), { recursive: true })
    mkdirSync(join(root, '清单'), { recursive: true })
    writePdf(join(root, '招标文件正文.pdf'), 'v1')
    writePdf(join(root, '图纸', '道路图纸.pdf'), 'drawing')
    writeFileSync(join(root, '清单', '工程量清单.xlsx'), Buffer.from([0x50, 0x4b, 0x03, 0x04]))

    expect(runInventory(root, output).status).toBe(0)
    writeFileSync(
      taskState,
      JSON.stringify({ schemaVersion: 1, stages: { '01': { status: 'completed' }, '04': { status: 'completed' } } }),
      'utf8'
    )
    writePdf(join(root, '招标文件正文.pdf'), 'v2')

    expect(runInventory(root, output).status).toBe(0)
    const changeSummary = JSON.parse(readFileSync(join(output, 'change-summary.json'), 'utf8'))
    const state = JSON.parse(readFileSync(taskState, 'utf8'))

    expect(changeSummary.modified).toEqual(['招标文件正文.pdf'])
    expect(changeSummary.affectedStages).toEqual(['requirements', 'boq', 'draft', 'deliver'])
    expect(state.stages['01'].status).toBe('completed')
    expect(state.stages['04'].status).toBe('completed')
  })
})
