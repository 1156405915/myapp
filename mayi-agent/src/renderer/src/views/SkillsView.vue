<script setup lang="ts">
import { ref } from 'vue'
import UiIcon from '@/components/UiIcon.vue'

interface SkillItem {
  icon: string
  title: string
  description: string
  enabled: boolean
}

const filter = ref('全部')
const query = ref('')
const filters = ['全部', '写作', '研发', '办公', '分析']
const recommended = ref<SkillItem[]>([
  { icon: 'file', title: '文档总结', description: '快速提炼文档重点', enabled: true },
  { icon: 'code', title: '代码解释', description: '解读并解释代码', enabled: true },
  { icon: 'web', title: '网页检索', description: '联网查找信息', enabled: true },
  { icon: 'note', title: '会议纪要', description: '整理会议要点', enabled: true }
])
const allSkills = ref<SkillItem[]>([
  { icon: 'table', title: '表格分析', description: '数据洞察与分析', enabled: true },
  { icon: 'flow', title: '流程图', description: '生成流程图示', enabled: true },
  { icon: 'note', title: '会议纪要', description: '整理会议要点', enabled: true },
  { icon: 'presentation', title: '生成PPT', description: '智能生成演示文稿', enabled: false },
  { icon: 'translate', title: '翻译润色', description: '翻译与润色优化', enabled: true },
  { icon: 'table', title: '数据分析', description: '进行数据分析与建模', enabled: false },
  { icon: 'file', title: '文档总结', description: '快速提炼文档重点', enabled: true },
  { icon: 'spark', title: '灵感头脑风暴', description: '激发创意灵感', enabled: false },
  { icon: 'folder', title: '文件解读', description: '解读文件内容', enabled: false },
  { icon: 'code', title: '代码解释', description: '解读并解释代码', enabled: true },
  { icon: 'web', title: '网页检索', description: '联网查找信息', enabled: true },
  { icon: 'flow', title: '思维导图', description: '生成思维导图', enabled: false },
  { icon: 'task', title: '任务拆解', description: '拆解任务步骤', enabled: false },
  { icon: 'mail', title: '邮件撰写', description: '撰写专业邮件', enabled: false }
])
</script>

<template>
  <section class="page catalog-page">
    <div class="catalog-toolbar">
      <label class="search-box"><UiIcon name="search" /><input v-model="query" placeholder="搜索技能名称或描述" /></label>
      <div class="segmented"><button v-for="item in filters" :key="item" :class="{ active: filter === item }" type="button" @click="filter = item">{{ item }}</button></div>
      <button class="sort-button" type="button">最近使用<UiIcon name="down" :size="16" /></button>
    </div>

    <div class="catalog-section-title"><strong>推荐技能</strong><small>根据你的使用习惯，为你推荐以下技能</small></div>
    <div class="recommended-grid">
      <article v-for="skill in recommended" :key="skill.title" class="skill-card horizontal">
        <UiIcon :name="skill.icon" :size="34" />
        <div><strong>{{ skill.title }}</strong><p>{{ skill.description }}</p><small>已启用</small></div>
        <button class="switch" :class="{ on: skill.enabled }" type="button" @click="skill.enabled = !skill.enabled"><span></span></button>
      </article>
    </div>

    <h3 class="all-title">全部技能</h3>
    <div class="all-skill-grid">
      <article v-for="skill in allSkills" :key="skill.title" class="skill-card">
        <button class="more-button" type="button"><UiIcon name="more" /></button>
        <UiIcon :name="skill.icon" :size="34" />
        <strong>{{ skill.title }}</strong><p>{{ skill.description }}</p>
        <footer><small :class="{ enabled: skill.enabled }">{{ skill.enabled ? '已启用' : '未启用' }}</small><button class="switch" :class="{ on: skill.enabled }" type="button" @click="skill.enabled = !skill.enabled"><span></span></button></footer>
      </article>
    </div>
  </section>
</template>
