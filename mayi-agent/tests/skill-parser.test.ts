import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseSkillDirectory, parseSkillFrontmatter } from '../src/main/skills/skill-parser'

const temporaryDirectories: string[] = []

function createSkillDirectory(id: string, manifestId = id): string {
  const root = mkdtempSync(join(tmpdir(), 'mayi-skill-'))
  temporaryDirectories.push(root)
  const directory = join(root, id)
  mkdirSync(directory)
  writeFileSync(
    join(directory, 'SKILL.md'),
    `---\nname: ${id}\ndescription: Test description\n---\n\n# Test\n`,
    'utf8'
  )
  writeFileSync(
    join(directory, 'mayi.json'),
    JSON.stringify({
      id: manifestId,
      displayName: '测试技能',
      description: '用于测试技能解析和产品展示。',
      category: 'document-intelligence',
      icon: 'file',
      version: '1.0.0',
      defaultEnabled: true,
      source: 'builtin',
      license: 'Test',
      requires: { skills: [], commands: [] },
      references: []
    }),
    'utf8'
  )
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('Skill 解析', () => {
  it('解析带引号的 frontmatter 描述', () => {
    expect(
      parseSkillFrontmatter('---\nname: demo-skill\ndescription: "A useful skill"\n---\n')
    ).toEqual({ name: 'demo-skill', description: 'A useful skill' })
  })

  it('读取并校验完整技能目录', () => {
    const skill = parseSkillDirectory(createSkillDirectory('demo-skill'))
    expect(skill.id).toBe('demo-skill')
    expect(skill.manifest.displayName).toBe('测试技能')
    expect(skill.manifest.description).toBe('用于测试技能解析和产品展示。')
  })

  it('拒绝目录、frontmatter 与产品元数据不一致', () => {
    expect(() => parseSkillDirectory(createSkillDirectory('demo-skill', 'other-skill'))).toThrow(
      '目录名、SKILL.md name 与 mayi.json id 必须一致'
    )
  })
})
