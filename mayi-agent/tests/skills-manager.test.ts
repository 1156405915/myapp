import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppStore } from '../src/main/store/app-store'

vi.mock('electron', () => ({
  app: { isPackaged: false }
}))

import { SkillsManager } from '../src/main/skills/skills-manager'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function createPlugin(
  dependencies: Record<string, string[]>,
  commandDependencies: Record<string, string[]> = {}
): string {
  const root = mkdtempSync(join(tmpdir(), 'mayi-skills-manager-'))
  temporaryDirectories.push(root)
  mkdirSync(join(root, '.claude-plugin'), { recursive: true })
  mkdirSync(join(root, 'skills'), { recursive: true })
  writeFileSync(
    join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'test-plugin', version: '1.0.0' }),
    'utf8'
  )
  for (const [id, requiredSkills] of Object.entries(dependencies)) {
    const directory = join(root, 'skills', id)
    mkdirSync(directory)
    writeFileSync(
      join(directory, 'SKILL.md'),
      `---\nname: ${id}\ndescription: Test ${id}\n---\n\n# Test\n`,
      'utf8'
    )
    writeFileSync(
      join(directory, 'mayi.json'),
      JSON.stringify({
        id,
        displayName: `测试技能 ${id}`,
        description: `用于验证 ${id} 的中文技能说明。`,
        category: 'test',
        icon: 'file',
        version: '1.0.0',
        defaultEnabled: true,
        source: 'builtin',
        license: 'Test',
        requires: { skills: requiredSkills, commands: commandDependencies[id] || [] },
        references: []
      }),
      'utf8'
    )
  }
  return root
}

function createStore(
  initialStates: Record<string, boolean> = {}
): AppStore & { states: Record<string, boolean> } {
  const states: Record<string, boolean> = { ...initialStates }
  return {
    states,
    listSkillStates: () => ({ ...states }),
    setSkillEnabled: (id: string, enabled: boolean) => {
      states[id] = enabled
    }
  } as unknown as AppStore & { states: Record<string, boolean> }
}

describe('SkillsManager', () => {
  it('仅发现保留的施组及文档基础技能', () => {
    const manager = new SkillsManager(createStore(), resolve('resources/skills-plugin'))
    const skills = manager.listSkills()

    expect(skills).toHaveLength(17)
    expect(skills.map((skill) => skill.id)).not.toContain('pptx')
    expect(skills.map((skill) => skill.id)).not.toContain('research-synthesis')
    expect(skills.map((skill) => skill.id)).toContain('document-summary')
    expect(skills.map((skill) => skill.id)).toContain('image-analysis')
    expect(skills.every((skill) => skill.source === 'builtin')).toBe(true)
    expect(skills.every((skill) => /[\u3400-\u9fff]/u.test(skill.description))).toBe(true)
    expect(skills.map((skill) => skill.id)).toContain('construction-organization-design')
    expect(skills.map((skill) => skill.id)).toContain('hefei-qingtian-precheck')
    expect(skills.map((skill) => skill.id)).toContain('construction-intake')
    expect(skills.map((skill) => skill.id)).toContain('construction-schedule-planning')
    expect(manager.getEnabledSkillIds()).toHaveLength(17)
  })

  it('持久化开关并从下一次快照排除禁用技能', () => {
    const store = createStore()
    const manager = new SkillsManager(store, resolve('resources/skills-plugin'))

    const updated = manager.setEnabled('document-summary', false)
    expect(updated.find((skill) => skill.id === 'document-summary')?.enabled).toBe(false)
    expect(manager.getEnabledSkillIds()).not.toContain('document-summary')
    expect(store.states['document-summary']).toBe(false)
  })

  it('为角色展开完整技能依赖且不修改全局开关', () => {
    const store = createStore({
      'hefei-qingtian-precheck': false,
      'construction-organization-design': false,
      'construction-intake': false,
      'construction-schedule-planning': false,
      'document-comparison': false,
      'image-analysis': false
    })
    const manager = new SkillsManager(store, resolve('resources/skills-plugin'))

    expect(
      manager.getRequiredSkillIds(['hefei-qingtian-precheck', 'image-analysis'])
    ).toEqual(
      expect.arrayContaining([
        'hefei-qingtian-precheck',
        'construction-organization-design',
        'construction-intake',
        'construction-schedule-planning',
        'bid-document-analysis',
        'document-comparison',
        'information-extraction',
        'professional-writing',
        'document-review',
        'docx',
        'pdf',
        'xlsx',
        'image-analysis'
      ])
    )
    expect(store.states).toEqual({
      'hefei-qingtian-precheck': false,
      'construction-organization-design': false,
      'construction-intake': false,
      'construction-schedule-planning': false,
      'document-comparison': false,
      'image-analysis': false
    })
  })

  it('拒绝未知技能和无效参数', () => {
    const manager = new SkillsManager(createStore(), resolve('resources/skills-plugin'))
    expect(() => manager.setEnabled('unknown', true)).toThrow('技能不存在')
    expect(() => manager.setEnabled('pdf', 'yes' as unknown as boolean)).toThrow('技能开关参数无效')
  })

  it('启用工作流时传递启用依赖并阻止单独关闭依赖', () => {
    const store = createStore({
      'construction-organization-design': false,
      'hefei-qingtian-precheck': false,
      'bid-document-analysis': false,
      'information-extraction': false,
      'document-review': false,
      'professional-writing': false,
      docx: false,
      pdf: false,
      xlsx: false
    })
    const manager = new SkillsManager(store, resolve('resources/skills-plugin'))

    const updated = manager.setEnabled('construction-organization-design', true)
    expect(updated.find((skill) => skill.id === 'bid-document-analysis')?.enabled).toBe(true)
    expect(updated.find((skill) => skill.id === 'information-extraction')?.enabledBy).toContain(
      '施工组织设计'
    )
    expect(manager.getEnabledSkillIds()).toEqual(
      expect.arrayContaining([
        'construction-organization-design',
        'construction-intake',
        'construction-schedule-planning',
        'bid-document-analysis',
        'document-comparison',
        'information-extraction',
        'professional-writing',
        'document-review',
        'docx',
        'pdf',
        'xlsx'
      ])
    )
    expect(() => manager.setEnabled('bid-document-analysis', false)).toThrow('请先停用这些工作流')
  })

  it('拒绝循环技能依赖', () => {
    const pluginPath = createPlugin({ 'skill-a': ['skill-b'], 'skill-b': ['skill-a'] })
    const manager = new SkillsManager(createStore(), pluginPath)

    expect(() => manager.listSkills()).toThrow('技能依赖存在循环：skill-a -> skill-b -> skill-a')
  })

  it('探测并展示命令依赖的真实状态', () => {
    const pluginPath = createPlugin({ 'skill-a': [] }, { 'skill-a': ['pandoc', 'pdftoppm'] })
    const manager = new SkillsManager(
      createStore(),
      pluginPath,
      (id) => (id === 'pandoc' ? 'C:\\Tools\\pandoc.exe' : null)
    )

    const dependencies = manager.listSkills()[0].dependencies
    expect(dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'pandoc', status: 'available' }),
        expect.objectContaining({ id: 'pdftoppm', status: 'missing' })
      ])
    )
    expect(manager.getMissingCommandIds('skill-a')).toEqual(['pdftoppm'])
  })

  it.runIf(process.platform === 'win32')('安装缺失依赖后重新探测', async () => {
    const pluginPath = createPlugin({ 'skill-a': [] }, { 'skill-a': ['pandoc'] })
    let installed = false
    const installer = vi.fn(async () => {
      installed = true
    })
    const manager = new SkillsManager(
      createStore(),
      pluginPath,
      () => (installed ? 'C:\\Tools\\pandoc.exe' : null),
      installer
    )

    const skills = await manager.installDependencies('skill-a')

    expect(installer).toHaveBeenCalledWith(['pandoc'])
    expect(skills[0].dependencies).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'pandoc', status: 'available' })])
    )
  })
})
