import type { SkillSource } from '../../shared/protocol'

export interface SkillReference {
  repository: string
  path?: string
  license: string
  usage: string
}

export interface MayiSkillManifest {
  id: string
  displayName: string
  description: string
  category: string
  icon: string
  version: string
  defaultEnabled: boolean
  recommended?: boolean
  source: SkillSource
  license: string
  requires?: {
    skills?: string[]
    commands?: string[]
  }
  references?: SkillReference[]
}

export interface DiscoveredSkill {
  id: string
  description: string
  manifest: MayiSkillManifest
}
