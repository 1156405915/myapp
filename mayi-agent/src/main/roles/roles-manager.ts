import { app } from 'electron'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RoleInfo } from '../../shared/protocol'

interface RoleDefinition extends RoleInfo {
  schemaVersion: number
  prompt: string
}

const moduleDirectory = dirname(fileURLToPath(import.meta.url))
const ROLE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 开发态读取源码资源，安装态读取 extraResources 中的角色定义。 */
export function getRolesPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'roles')
    : resolve(moduleDirectory, '../../resources/roles')
}

export class RolesManager {
  private definitions: RoleDefinition[] | null = null

  constructor(private readonly rolesPath = getRolesPath()) {}

  /** 返回不包含系统提示词的角色列表。 */
  listRoles(): RoleInfo[] {
    return this.loadDefinitions().map(({ prompt: _prompt, schemaVersion: _schemaVersion, ...role }) => role)
  }

  /** 只接受主进程资源中存在的角色 ID。 */
  getRole(roleId?: string): RoleDefinition | undefined {
    if (roleId === undefined) return undefined
    if (typeof roleId !== 'string' || !ROLE_ID_PATTERN.test(roleId)) throw new Error('角色 ID 无效')
    const role = this.loadDefinitions().find((item) => item.id === roleId)
    if (!role) throw new Error('角色不存在')
    return role
  }

  private loadDefinitions(): RoleDefinition[] {
    if (this.definitions) return this.definitions
    const definitions = readdirSync(this.rolesPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => {
        const path = join(this.rolesPath, entry.name)
        if (lstatSync(path).isSymbolicLink()) throw new Error(`角色定义不能是符号链接：${entry.name}`)
        return this.parseDefinition(path)
      })
      .sort((left, right) => left.displayName.localeCompare(right.displayName, 'zh-CN'))

    const ids = new Set<string>()
    for (const definition of definitions) {
      if (ids.has(definition.id)) throw new Error(`角色 ID 重复：${definition.id}`)
      ids.add(definition.id)
    }
    if (definitions.length === 0) throw new Error('至少需要一个可用角色')
    this.definitions = definitions
    return definitions
  }

  private parseDefinition(path: string): RoleDefinition {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const definition: RoleDefinition = {
      schemaVersion: raw.schemaVersion === 1 ? 1 : 0,
      id: typeof raw.id === 'string' ? raw.id.trim() : '',
      displayName: typeof raw.displayName === 'string' ? raw.displayName.trim() : '',
      description: typeof raw.description === 'string' ? raw.description.trim() : '',
      icon: typeof raw.icon === 'string' ? raw.icon.trim() : '',
      requiredSkillIds: Array.isArray(raw.requiredSkillIds)
        ? raw.requiredSkillIds.filter((id): id is string => typeof id === 'string').map((id) => id.trim())
        : [],
      prompt: typeof raw.prompt === 'string' ? raw.prompt.trim() : ''
    }
    if (
      definition.schemaVersion !== 1 ||
      !ROLE_ID_PATTERN.test(definition.id) ||
      !definition.displayName ||
      !/[\u3400-\u9fff]/u.test(definition.description) ||
      !definition.icon ||
      definition.requiredSkillIds.length === 0 ||
      definition.requiredSkillIds.some((id) => !ROLE_ID_PATTERN.test(id)) ||
      !definition.prompt
    ) {
      throw new Error(`角色定义无效：${path}`)
    }
    return definition
  }
}
