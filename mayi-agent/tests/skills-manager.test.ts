import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AppStore } from '../src/main/store/app-store'

vi.mock('electron', () => ({
  app: { isPackaged: false }
}))

import { SkillsManager } from '../src/main/skills/skills-manager'

function createStore(): AppStore & { states: Record<string, boolean> } {
  const states: Record<string, boolean> = {}
  return {
    states,
    listSkillStates: () => ({ ...states }),
    setSkillEnabled: (id: string, enabled: boolean) => {
      states[id] = enabled
    }
  } as unknown as AppStore & { states: Record<string, boolean> }
}

describe('SkillsManager', () => {
  it('发现十个内置技能并合并默认状态', () => {
    const manager = new SkillsManager(createStore(), resolve('resources/skills-plugin'))
    const skills = manager.listSkills()

    expect(skills).toHaveLength(10)
    expect(skills.map((skill) => skill.id)).toContain('document-summary')
    expect(skills.every((skill) => skill.source === 'builtin')).toBe(true)
    expect(manager.getEnabledSkillIds()).toHaveLength(10)
  })

  it('持久化开关并从下一次快照排除禁用技能', () => {
    const store = createStore()
    const manager = new SkillsManager(store, resolve('resources/skills-plugin'))

    const updated = manager.setEnabled('pptx', false)
    expect(updated.find((skill) => skill.id === 'pptx')?.enabled).toBe(false)
    expect(manager.getEnabledSkillIds()).not.toContain('pptx')
    expect(store.states.pptx).toBe(false)
  })

  it('拒绝未知技能和无效参数', () => {
    const manager = new SkillsManager(createStore(), resolve('resources/skills-plugin'))
    expect(() => manager.setEnabled('unknown', true)).toThrow('技能不存在')
    expect(() => manager.setEnabled('pdf', 'yes' as unknown as boolean)).toThrow('技能开关参数无效')
  })
})
