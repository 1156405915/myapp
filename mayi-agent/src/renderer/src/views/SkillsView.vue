<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import UiIcon from '@/components/UiIcon.vue'
import { useSkillsStore } from '@/stores/skills'
import type { SkillInfo } from '../../../shared/protocol'

const skills = useSkillsStore()
const filter = ref('all')
const query = ref('')
const filters = [
  { id: 'all', label: '全部' },
  { id: 'artifact', label: '文件格式' },
  { id: 'document-intelligence', label: '文档智能' },
  { id: 'bidding', label: '招标投标' },
  { id: 'construction', label: '工程建设' }
]

const normalizedQuery = computed(() => query.value.trim().toLocaleLowerCase())
const filteredSkills = computed(() =>
  skills.items.filter((skill) => {
    const matchesCategory = filter.value === 'all' || skill.category === filter.value
    const text = `${skill.displayName} ${skill.description} ${skill.id}`.toLocaleLowerCase()
    return matchesCategory && (!normalizedQuery.value || text.includes(normalizedQuery.value))
  })
)
const recommended = computed(() => skills.items.filter((skill) => skill.recommended).slice(0, 4))

function categoryLabel(category: string): string {
  return ({
    artifact: '文件格式',
    'document-intelligence': '文档智能',
    bidding: '招标投标',
    construction: '工程建设'
  }[category] || category)
}

/** 按不可用、联动启用、运行时依赖的优先级生成状态说明。 */
function dependencyText(skill: SkillInfo): string {
  const missing = skill.dependencies.filter((item) => item.status === 'missing')
  if (missing.length) return `缺少依赖：${missing.map((item) => item.label).join('、')}`
  if (skill.enabledBy.length) return `由 ${skill.enabledBy.join('、')} 联动启用`
  const commands = skill.dependencies.filter((item) => item.type === 'command')
  return commands.length ? `运行时依赖：${commands.map((item) => item.label).join('、')}` : '无需额外依赖'
}

onMounted(() => void skills.initialize())
</script>

<template>
  <section class="page catalog-page">
    <div class="catalog-toolbar">
      <label class="search-box"><UiIcon name="search" /><input v-model="query" placeholder="搜索技能名称或描述" /></label>
      <div class="segmented"><button v-for="item in filters" :key="item.id" :class="{ active: filter === item.id }" type="button" @click="filter = item.id">{{ item.label }}</button></div>
      <div class="skill-count"><strong>{{ skills.enabledCount }}</strong><span>/ {{ skills.items.length }} 已启用</span></div>
    </div>

    <div v-if="skills.error" class="skills-state error-state"><span>{{ skills.error }}</span><button type="button" @click="skills.refresh">重新加载</button></div>
    <div v-else-if="skills.loading && !skills.items.length" class="skills-state"><UiIcon name="refresh" /><span>正在读取内置技能…</span></div>

    <template v-else>
      <div class="catalog-section-title"><strong>推荐技能</strong><small>优先启用的文档处理与质量检查能力</small></div>
      <div class="recommended-grid">
      <article v-for="skill in recommended" :key="skill.id" class="skill-card horizontal" :class="{ unavailable: !skill.available }">
        <UiIcon :name="skill.icon" :size="34" />
        <div><strong>{{ skill.displayName }}</strong><p :title="skill.description">{{ skill.description }}</p><small>{{ skill.enabled ? '已启用' : skill.available ? '未启用' : '不可用' }}</small></div>
        <button class="switch" :class="{ on: skill.enabled }" type="button" role="switch" :aria-checked="skill.enabled" :aria-label="`${skill.enabled ? '停用' : '启用'}${skill.displayName}`" :disabled="!skill.available || skills.savingIds.includes(skill.id)" @click="skills.setEnabled(skill.id, !skill.enabled)"><span></span></button>
      </article>
      </div>

      <h3 class="all-title">全部技能</h3>
      <div v-if="!filteredSkills.length" class="skills-state">没有符合当前条件的技能</div>
      <div v-else class="all-skill-grid">
      <article v-for="skill in filteredSkills" :key="skill.id" class="skill-card" :class="{ unavailable: !skill.available }">
        <span class="skill-version">v{{ skill.version }}</span>
        <UiIcon :name="skill.icon" :size="34" />
        <strong>{{ skill.displayName }}</strong><p :title="skill.description">{{ skill.description }}</p>
        <div class="skill-meta"><span>{{ categoryLabel(skill.category) }}</span><span>{{ skill.sourceLabel }}</span></div>
        <div class="skill-dependency" :class="{ missing: !skill.available }">{{ dependencyText(skill) }}</div>
        <footer><small :class="{ enabled: skill.enabled }">{{ skill.enabled ? '已启用' : skill.available ? '未启用' : '不可用' }}</small><button class="switch" :class="{ on: skill.enabled }" type="button" role="switch" :aria-checked="skill.enabled" :aria-label="`${skill.enabled ? '停用' : '启用'}${skill.displayName}`" :disabled="!skill.available || skills.savingIds.includes(skill.id)" @click="skills.setEnabled(skill.id, !skill.enabled)"><span></span></button></footer>
      </article>
      </div>
    </template>
  </section>
</template>
