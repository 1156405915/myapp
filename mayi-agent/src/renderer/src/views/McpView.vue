<script setup lang="ts">
import { ref } from 'vue'
import UiIcon from '@/components/UiIcon.vue'

interface McpService {
  name: string
  description: string
  transport: string
  connected: boolean
  tools: number
  icon: string
}

const services = ref<McpService[]>([
  { name: 'Filesystem', description: '文件系统服务', transport: 'stdio', connected: true, tools: 12, icon: 'folder' },
  { name: 'GitHub', description: 'GitHub API 服务', transport: 'sse', connected: true, tools: 8, icon: 'code' },
  { name: 'Browser', description: '浏览器自动化服务', transport: 'stdio', connected: true, tools: 7, icon: 'web' },
  { name: 'PostgreSQL', description: 'PostgreSQL 数据库', transport: 'tcp', connected: true, tools: 6, icon: 'table' },
  { name: 'Notion', description: 'Notion 数据库服务', transport: 'http', connected: false, tools: 5, icon: 'note' }
])
const selected = ref(services.value[0])
</script>

<template>
  <section class="page mcp-page">
    <div class="metric-grid mcp-metrics">
      <article class="metric-card"><span class="metric-icon green"><UiIcon name="cube" /></span><div><strong>已连接服务</strong><b>4<small>/ 5</small></b><small>较昨日 +1 ↑</small></div></article>
      <article class="metric-card"><span class="metric-icon green"><UiIcon name="task" /></span><div><strong>可用工具</strong><b>38</b><small>较昨日 +6 ↑</small></div></article>
      <article class="metric-card"><span class="metric-icon green"><UiIcon name="refresh" /></span><div><strong>运行中</strong><b>4</b><small>● 100% 正常</small></div></article>
      <article class="metric-card"><span class="metric-icon orange"><UiIcon name="clock" /></span><div><strong>异常告警</strong><b>0</b><small>较昨日 0 —</small></div></article>
    </div>

    <div class="mcp-layout">
      <section class="service-list panel-card">
        <header><strong>MCP 服务</strong><button class="primary-small" type="button"><UiIcon name="plus" />添加服务</button></header>
        <div class="service-table-head"><span>服务名称</span><span>传输方式</span><span>状态</span><span>工具数</span></div>
        <button v-for="service in services" :key="service.name" class="service-row" :class="{ active: selected.name === service.name }" type="button" @click="selected = service">
          <span class="service-name"><i><UiIcon :name="service.icon" /></i><span><strong>{{ service.name }}</strong><small>{{ service.description }}</small></span></span>
          <em>{{ service.transport }}</em>
          <span class="connection-state" :class="{ off: !service.connected }"><i></i>{{ service.connected ? '已连接' : '未连接' }}</span>
          <b>{{ service.tools }}</b>
          <UiIcon name="chevron" :size="16" />
        </button>
        <footer>共 {{ services.length }} 项</footer>
      </section>

      <section class="service-detail panel-card">
        <header class="service-detail-title"><span><i><UiIcon :name="selected.icon" /></i><strong>{{ selected.name }}</strong><em>{{ selected.connected ? '已连接' : '未连接' }}</em></span><div><button class="primary-small" type="button">连接</button><button type="button">断开</button><button type="button"><UiIcon name="settings" />配置</button></div></header>
        <dl class="service-meta"><div><dt>传输方式</dt><dd>{{ selected.transport }}</dd></div><div><dt>版本</dt><dd>1.0.3</dd></div><div><dt>启动命令</dt><dd>npx -y @modelcontextprotocol/server-filesystem</dd></div><div><dt>工作目录</dt><dd>~/.mcp/filesystem</dd></div><div><dt>描述</dt><dd>提供安全的文件系统读写能力，支持目录遍历、文件读写与元数据操作。</dd></div><div><dt>连接时间</dt><dd>2026-08-04 23:58</dd></div></dl>
        <div class="tool-block"><header><strong>可用工具（{{ selected.tools }}）</strong><button type="button">查看全部</button></header><div><article><strong>read_file</strong><small>读取文件内容</small></article><article><strong>write_file</strong><small>写入文件内容</small></article><article><strong>list_directory</strong><small>列出目录内容</small></article><article><strong>search_files</strong><small>搜索文件</small></article></div></div>
        <div class="log-block"><header><strong>连接日志</strong><button type="button">清空日志</button></header><p><time>23:58:22</time><span>服务成功启动，传输方式：{{ selected.transport }}</span></p><p><time>23:58:23</time><span>工具加载完成，共 {{ selected.tools }} 个工具可用</span></p><p><time>23:58:25</time><span>工具调用成功，耗时 612ms</span></p></div>
      </section>
    </div>
  </section>
</template>
