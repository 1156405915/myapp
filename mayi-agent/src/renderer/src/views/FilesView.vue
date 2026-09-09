<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { ProjectSummary, ArtifactSummary } from '../../../shared/workflow'

const projects = ref<ProjectSummary[]>([])
const artifacts = ref<ArtifactSummary[]>([])
const selected = ref('')
const error = ref('')
let generation = 0
async function load(): Promise<void> {
  const request = ++generation
  const projectId = selected.value
  artifacts.value = []
  error.value = ''
  if (!projectId) return
  try {
    const result = await window.mayi.projects.artifacts(projectId)
    if (request === generation) artifacts.value = result
  } catch (cause) {
    if (request === generation) error.value = cause instanceof Error ? cause.message : String(cause)
  }
}
async function open(artifact: ArtifactSummary): Promise<void> {
  try {
    await window.mayi.projects.openArtifact(artifact.projectId, artifact.id)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}
onMounted(async () => {
  try {
    projects.value = await window.mayi.projects.list()
    selected.value = projects.value[0]?.id || ''
    await load()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
})
</script>

<template>
  <section class="page artifact-page">
    <h1>项目成果</h1>
    <p>仅显示已登记文件，不将模型回复中的路径视为交付物。</p>
    <label>项目 <select v-model="selected" @change="load"><option value="">请选择项目</option><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option></select></label>
    <button type="button" @click="load">刷新</button>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="!artifacts.length">暂无成果文件</p>
    <table v-else><thead><tr><th>文件</th><th>类型</th><th>大小</th><th>状态</th><th>操作</th></tr></thead><tbody><tr v-for="artifact in artifacts" :key="artifact.id"><td>{{ artifact.name }}</td><td>{{ artifact.kind }}</td><td>{{ artifact.size }} B</td><td>{{ artifact.status }}</td><td><button :disabled="artifact.status !== 'ready'" type="button" @click="open(artifact)">打开</button></td></tr></tbody></table>
  </section>
</template>

<style scoped>
.artifact-page { padding: 32px; overflow: auto; }
p { margin: 16px 0; }
select, button { padding: 10px 14px; border: 1px solid #cbd5d1; border-radius: 6px; }
th, td { padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }
[role='alert'] { color: #b42318; }
</style>
