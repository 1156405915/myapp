import { app } from 'electron'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SkillDependency, SkillInfo } from '../../shared/protocol'
import type { AppStore } from '../store/app-store'
import { parseSkillDirectory } from './skill-parser'
import type { DiscoveredSkill } from './skill-types'

const moduleDirectory = dirname(fileURLToPath(import.meta.url))

/** 开发态读取源码资源，安装态读取 extraResources 中的内置插件。 */
export function getSkillsPluginPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'skills-plugin')
    : resolve(moduleDirectory, '../../resources/skills-plugin')
}

export class SkillsManager {
  private definitions: DiscoveredSkill[] | null = null
  private pluginVersion = ''

  constructor(
    private readonly store: AppStore,
    private readonly pluginPath = getSkillsPluginPath()
  ) {}

  /** 返回合并资源定义、依赖状态和用户开关后的权威技能列表。 */
  listSkills(): SkillInfo[] {
    const definitions = this.loadDefinitions()
    const states = this.store.listSkillStates()
    const discoveredIds = new Set(definitions.map((skill) => skill.id))

    return definitions.map((skill) => {
      const dependencies: SkillDependency[] = [
        ...(skill.manifest.requires?.skills || []).map((id) => ({
          id,
          label: id,
          type: 'skill' as const,
          status: discoveredIds.has(id) ? ('available' as const) : ('missing' as const),
          required: true
        })),
        ...(skill.manifest.requires?.commands || []).map((id) => ({
          id,
          label: id,
          type: 'command' as const,
          status: 'unknown' as const,
          required: false
        }))
      ]
      const available = !dependencies.some(
        (dependency) => dependency.required && dependency.status === 'missing'
      )
      const requestedEnabled = states[skill.id] ?? skill.manifest.defaultEnabled

      return {
        id: skill.id,
        displayName: skill.manifest.displayName,
        description: skill.manifest.description,
        category: skill.manifest.category,
        icon: skill.manifest.icon,
        version: skill.manifest.version || this.pluginVersion,
        source: skill.manifest.source,
        sourceLabel: 'Mayi 内置',
        license: skill.manifest.license,
        recommended: Boolean(skill.manifest.recommended),
        enabled: requestedEnabled && available,
        available,
        dependencies
      }
    })
  }

  /** 更新内置技能开关，未知或不可用技能不能被启用。 */
  setEnabled(id: string, enabled: boolean): SkillInfo[] {
    if (typeof id !== 'string' || typeof enabled !== 'boolean') throw new Error('技能开关参数无效')
    const skill = this.listSkills().find((item) => item.id === id)
    if (!skill) throw new Error('技能不存在')
    if (enabled && !skill.available) throw new Error('技能依赖不完整，无法启用')
    this.store.setSkillEnabled(id, enabled)
    return this.listSkills()
  }

  /** 每次 Agent 任务开始时生成稳定的启用技能快照。 */
  getEnabledSkillIds(): string[] {
    return this.listSkills()
      .filter((skill) => skill.enabled && skill.available)
      .map((skill) => skill.id)
  }

  getPluginPath(): string {
    return this.pluginPath
  }

  /** 清理资源缓存，供后续刷新或安装流程复用。 */
  refresh(): SkillInfo[] {
    this.definitions = null
    return this.listSkills()
  }

  private loadDefinitions(): DiscoveredSkill[] {
    if (this.definitions) return this.definitions
    const pluginManifest = JSON.parse(
      readFileSync(join(this.pluginPath, '.claude-plugin', 'plugin.json'), 'utf8')
    ) as Record<string, unknown>
    if (typeof pluginManifest.version !== 'string' || !pluginManifest.version.trim()) {
      throw new Error('技能插件版本无效')
    }
    this.pluginVersion = pluginManifest.version.trim()

    const skillsDirectory = join(this.pluginPath, 'skills')
    const definitions = readdirSync(skillsDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const directory = join(skillsDirectory, entry.name)
        if (lstatSync(directory).isSymbolicLink()) throw new Error(`技能目录不能是符号链接：${entry.name}`)
        return parseSkillDirectory(directory)
      })
      .sort((left, right) => left.manifest.displayName.localeCompare(right.manifest.displayName, 'zh-CN'))

    const ids = new Set<string>()
    for (const definition of definitions) {
      if (ids.has(definition.id)) throw new Error(`技能 ID 重复：${definition.id}`)
      ids.add(definition.id)
    }
    this.definitions = definitions
    return definitions
  }
}
