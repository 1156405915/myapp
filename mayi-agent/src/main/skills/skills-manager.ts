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

  /** 汇总持久化开关，并将可用技能的依赖传递展开为最终启用状态。 */
  listSkills(): SkillInfo[] {
    const definitions = this.loadDefinitions()
    const states = this.store.listSkillStates()
    const definitionsById = new Map<string, DiscoveredSkill>(
      definitions.map((skill) => [skill.id, skill])
    )
    const availableIds = this.getAvailableIds(definitionsById)
    const requestedIds = new Set(
      definitions
        .filter((skill) => states[skill.id] ?? skill.manifest.defaultEnabled)
        .map((skill) => skill.id)
    )
    const enabledIds = new Set<string>()
    const enabledBy = new Map<string, Set<string>>()

    for (const rootId of requestedIds) {
      if (!availableIds.has(rootId)) continue
      const root = definitionsById.get(rootId)
      if (!root) continue
      this.visitDependencies(rootId, definitionsById, (id) => {
        enabledIds.add(id)
        if (id === rootId || requestedIds.has(id)) return
        const roots = enabledBy.get(id) || new Set<string>()
        roots.add(root.manifest.displayName)
        enabledBy.set(id, roots)
      })
    }

    return definitions.map((skill) => {
      const dependencies: SkillDependency[] = [
        ...(skill.manifest.requires?.skills || []).map((id) => ({
          id,
          label: definitionsById.get(id)?.manifest.displayName || id,
          type: 'skill' as const,
          status: availableIds.has(id) ? ('available' as const) : ('missing' as const),
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
        enabled: enabledIds.has(skill.id) && available,
        enabledBy: [...(enabledBy.get(skill.id) || [])].sort((left, right) =>
          left.localeCompare(right, 'zh-CN')
        ),
        available,
        dependencies
      }
    })
  }

  /** 更新显式开关；启用要求依赖完整，禁用不得破坏已启用工作流。 */
  setEnabled(id: string, enabled: boolean): SkillInfo[] {
    if (typeof id !== 'string' || typeof enabled !== 'boolean') throw new Error('技能开关参数无效')
    const skill = this.listSkills().find((item) => item.id === id)
    if (!skill) throw new Error('技能不存在')
    if (enabled && !skill.available) throw new Error('技能依赖不完整，无法启用')
    if (!enabled) {
      const definitions = this.loadDefinitions()
      const definitionsById = new Map<string, DiscoveredSkill>(
        definitions.map((definition) => [definition.id, definition])
      )
      const states = this.store.listSkillStates()
      const availableIds = this.getAvailableIds(definitionsById)
      const blockers = definitions.filter((definition) => {
        if (definition.id === id || !availableIds.has(definition.id)) return false
        const requested = states[definition.id] ?? definition.manifest.defaultEnabled
        return requested && this.dependsOn(definition.id, id, definitionsById)
      })
      if (blockers.length) {
        throw new Error(
          `该技能正被以下已启用工作流依赖：${blockers
            .map((definition) => definition.manifest.displayName)
            .join('、')}，请先停用这些工作流`
        )
      }
    }
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

  /** 加载并缓存技能定义，首次加载时完成唯一性和依赖图校验。 */
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
        if (lstatSync(directory).isSymbolicLink())
          throw new Error(`技能目录不能是符号链接：${entry.name}`)
        return parseSkillDirectory(directory)
      })
      .sort((left, right) =>
        left.manifest.displayName.localeCompare(right.manifest.displayName, 'zh-CN')
      )

    const ids = new Set<string>()
    for (const definition of definitions) {
      if (ids.has(definition.id)) throw new Error(`技能 ID 重复：${definition.id}`)
      ids.add(definition.id)
    }
    this.assertAcyclic(definitions)
    this.definitions = definitions
    return definitions
  }

  /** 仅当完整依赖链均存在时，技能才可被启用。 */
  private getAvailableIds(definitionsById: Map<string, DiscoveredSkill>): Set<string> {
    const available = new Set<string>()
    const unavailable = new Set<string>()

    const visit = (id: string, path: Set<string>): boolean => {
      if (available.has(id)) return true
      if (unavailable.has(id) || path.has(id)) return false
      const definition = definitionsById.get(id)
      if (!definition) return false
      const nextPath = new Set(path).add(id)
      const result = (definition.manifest.requires?.skills || []).every((dependencyId) =>
        visit(dependencyId, nextPath)
      )
      ;(result ? available : unavailable).add(id)
      return result
    }

    for (const id of definitionsById.keys()) visit(id, new Set())
    return available
  }

  /** 深度遍历技能及其全部传递依赖，每个节点最多访问一次。 */
  private visitDependencies(
    id: string,
    definitionsById: Map<string, DiscoveredSkill>,
    visitor: (id: string) => void,
    visited = new Set<string>()
  ): void {
    if (visited.has(id)) return
    visited.add(id)
    visitor(id)
    const definition = definitionsById.get(id)
    for (const dependencyId of definition?.manifest.requires?.skills || []) {
      if (definitionsById.has(dependencyId)) {
        this.visitDependencies(dependencyId, definitionsById, visitor, visited)
      }
    }
  }

  /** 判断工作流是否直接或间接依赖目标技能。 */
  private dependsOn(
    skillId: string,
    dependencyId: string,
    definitionsById: Map<string, DiscoveredSkill>
  ): boolean {
    let found = false
    this.visitDependencies(skillId, definitionsById, (id) => {
      if (id === dependencyId && id !== skillId) found = true
    })
    return found
  }

  /** 使用深度优先搜索拒绝依赖环，并保留完整环路用于报错。 */
  private assertAcyclic(definitions: DiscoveredSkill[]): void {
    const definitionsById = new Map<string, DiscoveredSkill>(
      definitions.map((definition) => [definition.id, definition])
    )
    const visited = new Set<string>()
    const visiting = new Set<string>()
    const path: string[] = []

    const visit = (id: string): void => {
      if (visited.has(id)) return
      if (visiting.has(id)) {
        const cycleStart = path.indexOf(id)
        throw new Error(`技能依赖存在循环：${[...path.slice(cycleStart), id].join(' -> ')}`)
      }
      visiting.add(id)
      path.push(id)
      const definition = definitionsById.get(id)
      for (const dependencyId of definition?.manifest.requires?.skills || []) {
        if (definitionsById.has(dependencyId)) visit(dependencyId)
      }
      path.pop()
      visiting.delete(id)
      visited.add(id)
    }

    for (const id of definitionsById.keys()) visit(id)
  }
}
