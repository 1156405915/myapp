import { ref } from 'vue'
import { defineStore } from 'pinia'

export const useUiStore = defineStore('ui', () => {
  const sidebarCollapsed = ref(false)
  const accountMenuOpen = ref(false)

  function toggleSidebar(): void {
    sidebarCollapsed.value = !sidebarCollapsed.value
  }

  function toggleAccountMenu(): void {
    accountMenuOpen.value = !accountMenuOpen.value
  }

  return { sidebarCollapsed, accountMenuOpen, toggleSidebar, toggleAccountMenu }
})
