<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { ProjectSummary, WorkflowSummary } from '../../../shared/workflow'

const projects = ref<ProjectSummary[]>([])
const runs = ref<WorkflowSummary[]>([])
const selected = ref('')
const name = ref('')
const error = ref('')
const busy = ref(false)
let request = 0

async function loadRuns(): Promise<void> {
  const generation = ++request
  runs.value = []
  error.value = ''
  const projectId = selected.value
  if (!projectId) return
  try {
    const result = await window.mayi.projects.runs(projectId)
    if (generation === request) runs.value = result
  } catch (cause) {
    if (generation === request) error.value = cause instanceof Error ? cause.message : String(cause)
  }
}

async function refresh(): Promise<void> {
  try {
    projects.value = await window.mayi.projects.list()
    if (!projects.value.some((p) => p.id === selected.value)) selected.value = projects.value[0]?.id || ''
    await loadRuns()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}

async function create(): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    const project = await window.mayi.projects.create(name.value)
    selected.value = project.id
    name.value = ''
    await refresh()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}
onMounted(() => void refresh())
</script>

<template>
  <section class="page project-page">
    <h1>施组项目</h1>
    <p>招标要求 → 清单分类 → 方案编制 → 文档交付</p>
    <form @submit.prevent="create">
      <input v-model="name" maxlength="200" required aria-label="项目名称" placeholder="输入项目名称" />
      <button type="submit" :disabled="busy">{{ busy ? '创建中…' : '创建项目' }}</button>
    </form>
    <p>工作区由应用自动创建。资料导入与阶段业务执行器尚未全部接通，当前不提供自动生成入口。</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <label>当前项目 <select v-model="selected" @change="loadRuns"><option value="">请选择项目</option><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option></select></label>
    <button type="button" @click="refresh">刷新</button>
    <h2>真实运行记录</h2>
    <p v-if="!runs.length">暂无运行记录</p>
    <table v-else><thead><tr><th>运行</th><th>状态</th><th>模式</th><th>输入版本</th></tr></thead><tbody><tr v-for="run in runs" :key="run.id"><td>{{ run.id }}</td><td>{{ run.status }}</td><td>{{ run.mode }}</td><td>{{ run.inputRevision }}</td></tr></tbody></table>
  </section>
</template>

<style scoped>
.project-page { padding: 32px; overflow: auto; }
form { display: flex; gap: 12px; margin: 24px 0; }
input, select, button { padding: 10px 14px; border: 1px solid #cbd5d1; border-radius: 6px; }
p { margin: 16px 0; line-height: 1.6; }
[role='alert'] { color: #b42318; }
th, td { padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }
h2 { margin-top: 24px; }
</style>
