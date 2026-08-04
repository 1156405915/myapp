<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AntLogo from '@/components/AntLogo.vue'
import UiIcon from '@/components/UiIcon.vue'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'

interface NavigationItem {
  label: string
  icon: string
  path: string
}

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const ui = useUiStore()
const searchOpen = ref(false)

const navigation: NavigationItem[] = [
  { label: '任务', icon: 'task', path: '/tasks' },
  { label: 'MCP工具', icon: 'cube', path: '/mcp' },
  { label: '技能', icon: 'spark', path: '/skills' },
  { label: '文件库', icon: 'folder', path: '/files' }
]

const recentChats = [
  { title: '高保真块分析', date: '10-24' },
  { title: 'MCP 接入方案', date: '昨天' },
  { title: '文件库结构优化', date: '昨天' },
  { title: '技能设计评审', date: '周一' },
  { title: '任务看板整理', date: '上周五' },
  { title: 'Agent 鉴权策略', date: '上周四' },
  { title: '沙箱执行流程', date: '上周三' }
]

const user = computed(() => auth.user ?? { name: 'zhangsan', email: 'zhangsan@ac.com', initials: 'Z' })

function openNewChat(): void {
  void router.push('/chat')
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
          <input aria-label="搜索会话" placeholder="搜索会话" />
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
          <UiIcon name="more" :size="18" />
        </div>
        <div class="recent-scroll">
          <button
            v-for="chat in recentChats"
            :key="chat.title"
            class="recent-item"
            :class="{ active: route.path === '/chat' && chat.title === '高保真块分析' }"
            type="button"
            @click="openNewChat"
          >
            <UiIcon name="chat" :size="16" />
            <span class="recent-title">{{ chat.title }}</span>
            <time>{{ chat.date }}</time>
          </button>
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
            <button type="button"><UiIcon name="settings" />设置</button>
            <button type="button" @click="handleLogout"><UiIcon name="logout" />退出登录</button>
          </div>
        </Transition>
      </div>
    </aside>

    <main class="workspace">
      <RouterView />
    </main>
  </div>
</template>
