import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false }
}))

import { RolesManager } from '../src/main/roles/roles-manager'

describe('RolesManager', () => {
  it('只向界面暴露角色展示信息', () => {
    const manager = new RolesManager(resolve('resources/roles'))

    expect(manager.listRoles()).toEqual([
      {
        id: 'construction-organization-expert',
        displayName: '施组编制专家',
        description: '读取招标文件、图纸、清单和项目材料，编制、校验并交付施工组织设计。',
        icon: 'task',
        requiredSkillIds: [
          'construction-organization-design',
          'image-analysis'
        ]
      }
    ])
    expect(manager.listRoles()[0]).not.toHaveProperty('prompt')
  })

  it('由主进程解析角色工作流并拒绝未知角色', () => {
    const manager = new RolesManager(resolve('resources/roles'))

    expect(manager.getRole('construction-organization-expert')?.prompt).toContain('施组编制专家')
    expect(manager.getRole('construction-organization-expert')?.prompt).toContain('四阶段工作流')
    expect(manager.getRole('construction-organization-expert')?.prompt).not.toContain('八阶段工作流')
    expect(() => manager.getRole('unknown-role')).toThrow('角色不存在')
    expect(() => manager.getRole('../role')).toThrow('角色 ID 无效')
  })
})
