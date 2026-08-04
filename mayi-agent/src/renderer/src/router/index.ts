import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/LoginView.vue'),
    meta: { public: true }
  },
  {
    path: '/',
    component: () => import('@/layouts/AppShell.vue'),
    children: [
      { path: '', redirect: '/chat' },
      { path: 'chat', name: 'chat', component: () => import('@/views/ChatView.vue') },
      { path: 'tasks', name: 'tasks', component: () => import('@/views/TasksView.vue') },
      { path: 'mcp', name: 'mcp', component: () => import('@/views/McpView.vue') },
      { path: 'skills', name: 'skills', component: () => import('@/views/SkillsView.vue') },
      { path: 'files', name: 'files', component: () => import('@/views/FilesView.vue') }
    ]
  },
  { path: '/:pathMatch(.*)*', redirect: '/chat' }
]

const router = createRouter({
  history: createWebHashHistory(),
  routes
})

router.beforeEach((to) => {
  const auth = useAuthStore()
  if (!to.meta.public && !auth.isAuthenticated) return { name: 'login' }
  if (to.name === 'login' && auth.isAuthenticated) return { name: 'chat' }
  return true
})

export default router
