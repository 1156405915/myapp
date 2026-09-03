import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { SkillInfo } from '../../../shared/protocol'

export const useSkillsStore = defineStore('skills', () => {
  const items = ref<SkillInfo[]>([])
  const loading = ref(false)
  const savingIds = ref<string[]>([])
  const installingIds = ref<string[]>([])
  const error = ref('')
  const initialized = ref(false)
  let initializePromise: Promise<void> | null = null

  const enabledCount = computed(() => items.value.filter((skill) => skill.enabled).length)

  /** 合并并发初始化并以主进程列表作为唯一数据源。 */
  async function initialize(): Promise<void> {
    if (initialized.value) return
    if (initializePromise) return initializePromise
    initializePromise = refresh().finally(() => {
      initializePromise = null
    })
    return initializePromise
  }

  /** 重新读取技能资源、依赖和持久化开关状态。 */
  async function refresh(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      items.value = await window.mayi.skills.list()
      initialized.value = true
    } catch (reason) {
      setError(reason)
    } finally {
      loading.value = false
    }
  }

  /** 保存期间锁定单项开关，失败时保留主进程原状态。 */
  async function setEnabled(id: string, enabled: boolean): Promise<void> {
    if (savingIds.value.includes(id)) return
    savingIds.value = [...savingIds.value, id]
    error.value = ''
    try {
      items.value = await window.mayi.skills.setEnabled({ id, enabled })
    } catch (reason) {
      setError(reason)
    } finally {
      savingIds.value = savingIds.value.filter((item) => item !== id)
    }
  }

  async function installDependencies(id: string): Promise<void> {
    if (installingIds.value.includes(id)) return
    installingIds.value = [...installingIds.value, id]
    error.value = ''
    try {
      items.value = await window.mayi.skills.installDependencies({ id })
    } catch (reason) {
      setError(reason)
    } finally {
      installingIds.value = installingIds.value.filter((item) => item !== id)
    }
  }

  function setError(reason: unknown): void {
    error.value = reason instanceof Error ? reason.message : String(reason)
  }

  return {
    items,
    loading,
    savingIds,
    installingIds,
    error,
    initialized,
    enabledCount,
    initialize,
    refresh,
    setEnabled,
    installDependencies
  }
})
