<script setup lang="ts">
import UiIcon from '@/components/UiIcon.vue'

const stats = [
  { icon: 'task', label: '全部任务', value: 12, hint: '所有任务总数', tone: 'green' },
  { icon: 'clock', label: '进行中', value: 5, hint: '正在推进的任务', tone: 'blue' },
  { icon: 'check', label: '已完成', value: 4, hint: '已完成的任务', tone: 'green' },
  { icon: 'clock', label: '即将到期', value: 3, hint: '7天内到期任务', tone: 'orange' }
]

const columns = [
  {
    title: '待处理',
    color: 'gray',
    tasks: [
      ['对话框页面需求分析', '梳理对话框功能及核心需求，形成文档。', '10月28日', '高优先级'],
      ['文件库结构优化设计', '优化文件库分类与权限结构，提升检索效率。', '11月02日', '中优先级'],
      ['技能模块交互评审', '评审技能模块交互与信息架构。', '11月05日', '低优先级']
    ]
  },
  {
    title: '进行中',
    color: 'blue',
    tasks: [
      ['MCP 接入方案设计', '设计 MCP 接入架构与认证流程。', '10月30日', '高优先级'],
      ['任务看板功能实现', '完成任务看板前端开发与状态管理。', '11月04日', '中优先级'],
      ['流程图生成模块开发', '支持多种图形样式与导出。', '11月06日', '中优先级']
    ]
  },
  {
    title: '已完成',
    color: 'green',
    tasks: [
      ['网页检索功能实现', '支持结果摘要与引用。', '10月20日', '中优先级'],
      ['文档总结能力优化', '提升准确性与可读性。', '10月18日', '中优先级'],
      ['基础权限体系设计', '完成角色模型与权限边界。', '10月15日', '低优先级']
    ]
  }
]
</script>

<template>
  <section class="page dashboard-page">
    <div class="metric-grid">
      <article v-for="item in stats" :key="item.label" class="metric-card">
        <span class="metric-icon" :class="item.tone"><UiIcon :name="item.icon" :size="28" /></span>
        <div><strong>{{ item.label }}</strong><b>{{ item.value }}</b><small>{{ item.hint }}</small></div>
      </article>
    </div>

    <div class="kanban">
      <section v-for="column in columns" :key="column.title" class="kanban-column">
        <header><span class="status-dot" :class="column.color"></span><strong>{{ column.title }}</strong><small>{{ column.tasks.length }}</small><UiIcon name="more" /></header>
        <article v-for="task in column.tasks" :key="task[0]" class="task-card">
          <strong>{{ task[0] }}</strong>
          <p>{{ task[1] }}</p>
          <footer><span><UiIcon name="clock" :size="14" />{{ task[2] }}</span><em>{{ task[3] }}</em><i>Z</i></footer>
        </article>
      </section>
    </div>

    <div class="quick-create"><UiIcon name="plus" /><span>创建新任务（按 Enter 快速创建）</span><button type="button"><UiIcon name="send" /></button></div>
  </section>
</template>
