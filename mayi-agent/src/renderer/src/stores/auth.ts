import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

export interface CurrentUser {
  name: string
  email: string
  initials: string
}

const STORAGE_KEY = 'mayi.auth.user'

function loadUser(): CurrentUser | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as CurrentUser) : null
  } catch {
    return null
  }
}

export const useAuthStore = defineStore('auth', () => {
  const user = ref<CurrentUser | null>(loadUser())
  const isAuthenticated = computed(() => Boolean(user.value))

  async function login(identifier: string, password: string): Promise<void> {
    const cleanIdentifier = identifier.trim()
    if (!cleanIdentifier) throw new Error('请输入邮箱或用户名')
    if (password.length < 6) throw new Error('密码至少需要 6 位')

    await new Promise((resolve) => window.setTimeout(resolve, 450))

    const name = cleanIdentifier.includes('@') ? cleanIdentifier.split('@')[0] : cleanIdentifier
    user.value = {
      name,
      email: cleanIdentifier.includes('@') ? cleanIdentifier : `${cleanIdentifier}@mayi.ai`,
      initials: name.slice(0, 1).toUpperCase()
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(user.value))
  }

  async function loginWithProvider(provider: string): Promise<void> {
    await new Promise((resolve) => window.setTimeout(resolve, 350))
    user.value = {
      name: 'zhangsan',
      email: `zhangsan@${provider.toLowerCase()}.example`,
      initials: 'Z'
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(user.value))
  }

  function logout(): void {
    user.value = null
    localStorage.removeItem(STORAGE_KEY)
  }

  return { user, isAuthenticated, login, loginWithProvider, logout }
})
