<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AntLogo from '@/components/AntLogo.vue'
import UiIcon from '@/components/UiIcon.vue'
import { useAuthStore } from '@/stores/auth'
import { useChatStore } from '@/stores/chat'
import { useUiStore } from '@/stores/ui'

interface NavigationItem {
  label: string
  icon: string
  path: string
}

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const chat = useChatStore()
const ui = useUiStore()
const searchOpen = ref(false)
const searchQuery = ref('')
const settingsOpen = ref(false)
const settingsError = ref('')
const settingsSuccess = ref('')
const settingsSaving = ref(false)
const settingsForm = reactive({ apiKey: '', model: 'deepseek-v4-pro', cwd: '' })

const navigation: NavigationItem[] = [
  { label: '任务', icon: 'task', path: '/tasks' },
  { label: 'MCP工具', icon: 'cube', path: '/mcp' },
  { label: '技能', icon: 'spark', path: '/skills' },
  { label: '文件库', icon: 'folder', path: '/files' }
]

const user = computed(() => auth.user ?? { name: 'zhangsan', email: 'zhangsan@ac.com', initials: 'Z' })
const filteredSessions = computed(() => {
  const keyword = searchQuery.value.trim().toLocaleLowerCase()
  if (!keyword) return chat.sessions
  return chat.sessions.filter((session) => session.title.toLocaleLowerCase().includes(keyword))
})

onMounted(() => void chat.initialize())

async function openNewChat(): Promise<void> {
  await chat.createNewSession()
  await router.push('/chat')
}

async function openSession(sessionId: string): Promise<void> {
  await router.push('/chat')
  await chat.selectSession(sessionId)
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp)
  const today = new Date()
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

function openSettings(): void {
  settingsOpen.value = true
  ui.accountMenuOpen = false
  settingsForm.apiKey = ''
  settingsForm.model = chat.config?.model || 'deepseek-v4-pro'
  settingsForm.cwd = chat.config?.cwd || ''
  settingsError.value = ''
  settingsSuccess.value = ''
}

async function chooseDirectory(): Promise<void> {
  const selected = await chat.selectDirectory()
  if (selected) settingsForm.cwd = selected
}

async function saveSettings(): Promise<void> {
  if (!settingsForm.apiKey.trim() && !chat.config?.hasApiKey) {
    settingsError.value = '请输入 DeepSeek API Key'
    return
  }

  settingsSaving.value = true
  settingsError.value = ''
  settingsSuccess.value = ''
  try {
    await chat.saveConfig({ ...settingsForm })
    settingsForm.apiKey = ''
    settingsSuccess.value = '配置已保存'
  } catch (error) {
    settingsError.value = error instanceof Error ? error.message : String(error)
  } finally {
    settingsSaving.value = false
  }
}

function handleLogout(): void {
  auth.logout()
  ui.accountMenuOpen = false
  void router.push('/login')
}
</script>

<template>
  <div class="app-shell" :class="{ 'is-collapsed': ui.sidebarCollapsed }">
    <aside class="sidebar">
      <div class="brand-row">
        <button class="brand" type="button" @click="openNewChat">
          <AntLogo :size="40" />
          <strong v-if="!ui.sidebarCollapsed">蚂蚁</strong>
        </button>
        <div v-if="!ui.sidebarCollapsed" class="brand-actions">
          <button class="icon-button" type="button" aria-label="搜索" @click="searchOpen = !searchOpen">
            <UiIcon name="search" />
          </button>
          <button class="icon-button" type="button" aria-label="折叠侧边栏" @click="ui.toggleSidebar">
            <UiIcon name="panel" />
          </button>
        </div>
        <button v-else class="icon-button" type="button" aria-label="展开侧边栏" @click="ui.toggleSidebar">
          <UiIcon name="panel" />
        </button>
      </div>

      <Transition name="fade-slide">
        <div v-if="searchOpen && !ui.sidebarCollapsed" class="sidebar-search">
          <UiIcon name="search" :size="17" />
          <input v-model="searchQuery" aria-label="搜索会话" placeholder="搜索会话" />
        </div>
      </Transition>

      <button class="new-chat" type="button" @click="openNewChat">
        <UiIcon name="chat" />
        <span v-if="!ui.sidebarCollapsed">新建会话</span>
        <UiIcon v-if="!ui.sidebarCollapsed" class="new-chat-plus" name="plus" />
      </button>

      <nav class="primary-nav" aria-label="主导航">
        <RouterLink
          v-for="item in navigation"
          :key="item.path"
          :to="item.path"
          class="nav-link"
          :title="item.label"
        >
          <UiIcon :name="item.icon" />
          <span v-if="!ui.sidebarCollapsed">{{ item.label }}</span>
        </RouterLink>
      </nav>

      <div v-if="!ui.sidebarCollapsed" class="recent-section">
        <div class="section-heading">
          <span>最近会话</span>
          <small>{{ chat.sessions.length }}</small>
        </div>
        <div class="recent-scroll">
          <button
            v-for="session in filteredSessions"
            :key="session.id"
            class="recent-item"
            :class="{ active: route.path === '/chat' && session.id === chat.activeSessionId }"
            type="button"
            @click="openSession(session.id)"
          >
            <UiIcon name="chat" :size="16" />
            <span class="recent-title">{{ session.title }}</span>
            <time>{{ formatDate(session.updatedAt) }}</time>
          </button>
          <p v-if="filteredSessions.length === 0" class="recent-empty">暂无会话</p>
        </div>
      </div>

      <div class="account-dock">
        <button class="account-button" type="button" @click="ui.toggleAccountMenu">
          <span class="avatar">{{ user.initials }}</span>
          <span v-if="!ui.sidebarCollapsed" class="account-copy">
            <strong>{{ user.name }}</strong>
            <small>{{ user.email }}</small>
          </span>
          <UiIcon v-if="!ui.sidebarCollapsed" name="down" :size="16" />
        </button>

        <Transition name="account-pop">
          <div v-if="ui.accountMenuOpen && !ui.sidebarCollapsed" class="account-menu">
            <button type="button"><UiIcon name="user" />个人资料</button>
            <button type="button" @click="openSettings"><UiIcon name="settings" />Agent 设置</button>
            <button type="button" @click="handleLogout"><UiIcon name="logout" />退出登录</button>
          </div>
        </Transition>
      </div>
    </aside>

    <main class="workspace">
      <RouterView />
    </main>

    <Teleport to="body">
      <div v-if="settingsOpen" class="modal-backdrop" @click.self="settingsOpen = false">
        <form class="settings-modal" @submit.prevent="saveSettings">
        <header>
          <div>
            <h2>Agent 设置</h2>
            <p>配置 DeepSeek 模型和默认工作目录</p>
          </div>
          <button type="button" aria-label="关闭" @click="settingsOpen = false">×</button>
        </header>
        <label>
          <span>DeepSeek API Key</span>
          <input
            v-model="settingsForm.apiKey"
            type="password"
            autocomplete="off"
            :placeholder="chat.config?.hasApiKey ? '已安全保存，留空则不修改' : '输入 DeepSeek API Key'"
          />
        </label>
        <label>
          <span>模型</span>
          <select v-model="settingsForm.model">
            <option value="deepseek-v4-pro">DeepSeek V4 Pro</option>
            <option value="deepseek-v4-flash">DeepSeek V4 Flash</option>
          </select>
        </label>
        <label>
          <span>工作目录</span>
          <div class="directory-field">
            <input v-model="settingsForm.cwd" />
            <button type="button" @click="chooseDirectory">选择</button>
          </div>
        </label>
        <p v-if="settingsError" class="settings-error">{{ settingsError }}</p>
        <p v-if="settingsSuccess" class="settings-success">{{ settingsSuccess }}</p>
        <footer>
          <button type="button" @click="settingsOpen = false">取消</button>
          <button class="primary-action" type="submit" :disabled="settingsSaving">
            {{ settingsSaving ? '保存中…' : '保存' }}
          </button>
        </footer>
        </form>
      </div>
    </Teleport>
  </div>
</template>
