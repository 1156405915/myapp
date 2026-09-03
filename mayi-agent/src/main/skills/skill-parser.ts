import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { DiscoveredSkill, MayiSkillManifest } from './skill-types'

const SKILL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

function parseScalar(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return JSON.parse(trimmed) as string
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1)
  return trimmed
}

/** 仅提取 SDK 用于发现技能的必要 frontmatter 字段。 */
export function parseSkillFrontmatter(content: string): { name: string; description: string } {
  const normalized = content.replace(/^\uFEFF/, '')
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match) throw new Error('SKILL.md 缺少有效 frontmatter')

  const values = new Map<string, string>()
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/)
    if (field) values.set(field[1], parseScalar(field[2]))
  }

  const name = values.get('name')?.trim() || ''
  const description = values.get('description')?.trim() || ''
  if (!SKILL_ID_PATTERN.test(name)) throw new Error('SKILL.md 的 name 无效')
  if (!description) throw new Error('SKILL.md 的 description 不能为空')
  return { name, description }
}

function readStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${field} 必须是非空字符串数组`)
  }
  return value.map((item) => item.trim())
}

/** 解析并校验产品元数据、目录身份及技能依赖声明。 */
export function parseSkillDirectory(directory: string): DiscoveredSkill {
  const directoryId = basename(directory)
  const frontmatter = parseSkillFrontmatter(readFileSync(join(directory, 'SKILL.md'), 'utf8'))
  const raw = JSON.parse(readFileSync(join(directory, 'mayi.json'), 'utf8')) as Record<
    string,
    unknown
  >
  const manifest: MayiSkillManifest = {
    id: typeof raw.id === 'string' ? raw.id.trim() : '',
    displayName: typeof raw.displayName === 'string' ? raw.displayName.trim() : '',
    description: typeof raw.description === 'string' ? raw.description.trim() : '',
    category: typeof raw.category === 'string' ? raw.category.trim() : '',
    icon: typeof raw.icon === 'string' ? raw.icon.trim() : '',
    version: typeof raw.version === 'string' ? raw.version.trim() : '',
    defaultEnabled: raw.defaultEnabled === true,
    recommended: raw.recommended === true,
    source: raw.source === 'builtin' ? 'builtin' : ('' as 'builtin'),
    license: typeof raw.license === 'string' ? raw.license.trim() : '',
    requires:
      raw.requires && typeof raw.requires === 'object'
        ? {
            skills: readStringArray(
              (raw.requires as Record<string, unknown>).skills,
              'requires.skills'
            ),
            commands: readStringArray(
              (raw.requires as Record<string, unknown>).commands,
              'requires.commands'
            )
          }
        : undefined,
    references: Array.isArray(raw.references)
      ? raw.references.map((entry, index) => {
          if (!entry || typeof entry !== 'object') throw new Error(`references[${index}] 无效`)
          const value = entry as Record<string, unknown>
          if (
            typeof value.repository !== 'string' ||
            typeof value.license !== 'string' ||
            typeof value.usage !== 'string'
          ) {
            throw new Error(`references[${index}] 缺少必要字段`)
          }
          return {
            repository: value.repository.trim(),
            path: typeof value.path === 'string' ? value.path.trim() : undefined,
            license: value.license.trim(),
            usage: value.usage.trim()
          }
        })
      : []
  }

  if (!SKILL_ID_PATTERN.test(manifest.id)) throw new Error('mayi.json 的 id 无效')
  if (manifest.id !== directoryId || manifest.id !== frontmatter.name) {
    throw new Error('目录名、SKILL.md name 与 mayi.json id 必须一致')
  }
  if (
    !manifest.displayName ||
    !manifest.description ||
    !/[\u3400-\u9fff]/u.test(manifest.description) ||
    !manifest.category ||
    !manifest.icon ||
    !manifest.license
  ) {
    throw new Error('mayi.json 缺少展示元数据')
  }
  if (!VERSION_PATTERN.test(manifest.version)) throw new Error('mayi.json 的 version 无效')
  if (manifest.source !== 'builtin') throw new Error('首期只允许内置技能')
  const requiredSkills = manifest.requires?.skills || []
  if (requiredSkills.some((id) => !SKILL_ID_PATTERN.test(id))) {
    throw new Error('requires.skills 包含无效技能 ID')
  }
  if (new Set(requiredSkills).size !== requiredSkills.length) {
    throw new Error('requires.skills 不能包含重复技能 ID')
  }
  const requiredCommands = manifest.requires?.commands || []
  if (requiredCommands.some((id) => !SKILL_ID_PATTERN.test(id))) {
    throw new Error('requires.commands 包含无效命令 ID')
  }
  if (new Set(requiredCommands).size !== requiredCommands.length) {
    throw new Error('requires.commands 不能包含重复命令 ID')
  }

  return { id: manifest.id, description: frontmatter.description, manifest }
}
