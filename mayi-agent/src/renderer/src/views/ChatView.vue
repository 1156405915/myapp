<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import MarkdownContent from '@/components/MarkdownContent.vue'
import UiIcon from '@/components/UiIcon.vue'
import { useChatStore } from '@/stores/chat'
import { useSkillsStore } from '@/stores/skills'
import type { ChatMessage, ContentBlock } from '../../../shared/protocol'

const chat = useChatStore()
const skills = useSkillsStore()
const message = ref('')
const sending = ref(false)
const copiedMessageId = ref<string | null>(null)
const messageList = ref<HTMLElement | null>(null)
const skillShortcuts = computed(() => {
  const enabled = skills.items.filter((skill) => skill.enabled && skill.available)
  return [...enabled.filter((skill) => skill.recommended), ...enabled.filter((skill) => !skill.recommended)].slice(0, 8)
})

// ChatView 可能晚于布局挂载，store 会避免重复初始化和重复监听。
onMounted(() => {
  void chat.initialize()
  void skills.initialize()
})

// 仅观察影响列表高度的数据，并等待 DOM 更新后再滚动。
watch(
  () => [chat.messages.length, chat.streamingContent],
  async () => {
    await nextTick()
    messageList.value?.scrollTo({ top: messageList.value.scrollHeight, behavior: 'smooth' })
  }
)

/** 将快捷技能名称预填入输入框，保留用户继续补充需求的空间。 */
function useSkill(id: string, displayName: string): void {
  message.value = `请使用 ${id}（${displayName}）技能帮我：`
}

/** 防止 IPC 提交阶段重复发送，并在成功提交后清空输入。 */
async function submit(): Promise<void> {
  const prompt = message.value.trim()
  if (!prompt || sending.value) return
  sending.value = true
  try {
    await chat.send(prompt)
    message.value = ''
  } finally {
    sending.value = false
  }
}

/** 支持 Enter 发送，同时避免中文输入法确认候选时误提交。 */
function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    void submit()
  }
}

/** 将消息时间格式化为当天时间或月日时间。 */
function formatMessageTime(timestamp: number): string {
  const date = new Date(timestamp)
  const today = new Date()
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  if (date.toDateString() === today.toDateString()) return `今天 ${time}`
  return `${date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })} ${time}`
}

/** 复制消息，并避免旧定时器清除后来触发的复制反馈。 */
async function copyMessage(id: string, content: string): Promise<void> {
  await window.mayi.copyText(content)
  copiedMessageId.value = id
  window.setTimeout(() => {
    if (copiedMessageId.value === id) copiedMessageId.value = null
  }, 1600)
}

/** 将消息中的结构化块转换为适合复制的纯文本。 */
function messageText(item: ChatMessage): string {
  return item.blocks
    .map((block) => {
      if (block.type === 'text') return block.text
      if (block.type === 'thinking') return block.thinking
      if (block.type === 'tool_use') return `${block.toolName}\n${JSON.stringify(block.input, null, 2)}`
      if (block.type === 'tool_result') return block.content
      return block.message
    })
    .filter(Boolean)
    .join('\n\n')
}

/** 格式化工具输入，避免模板中重复处理异常 JSON 值。 */
function formatToolInput(block: Extract<ContentBlock, { type: 'tool_use' }>): string {
  return JSON.stringify(block.input, null, 2)
}

/** 将毫秒耗时格式化为紧凑的秒或分钟文本。 */
function formatDuration(durationMs: number): string {
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)} 秒`
  return `${Math.floor(durationMs / 60_000)} 分 ${Math.round((durationMs % 60_000) / 1000)} 秒`
}

/** 计算并限制上下文窗口百分比，避免异常数据撑破进度条。 */
function contextPercentage(item: ChatMessage): number {
  if (!item.contextUsage?.maxTokens) return 0
  return Math.min(100, Math.round((item.contextUsage.usedTokens / item.contextUsage.maxTokens) * 100))
}

</script>

<template>
  <section class="page chat-page" :class="{ 'has-messages': chat.messages.length > 0 || chat.streamingContent }">
    <div v-if="chat.messages.length === 0 && !chat.streamingContent" class="chat-empty">
      <div class="welcome-copy">
        <h1>今天想完成什么？</h1>
        <p>蚂蚁可以阅读办公文件、整理资料、审查内容并生成专业文档。</p>
      </div>
      <div class="skill-heading">已启用技能</div>
      <div class="skill-shortcuts">
        <button v-for="skill in skillShortcuts" :key="skill.id" type="button" @click="useSkill(skill.id, skill.displayName)">
          <UiIcon :name="skill.icon" :size="34" />
          <span><strong>{{ skill.displayName }}</strong><small>{{ skill.description }}</small></span>
        </button>
      </div>
    </div>

    <div v-else ref="messageList" class="message-list">
      <header class="conversation-header">
        <div><small>当前会话</small><strong>{{ chat.activeSession?.title || '新会话' }}</strong></div>
        <span v-if="chat.isRunning" class="running-badge"><i></i>Agent 运行中</span>
      </header>

      <article v-for="item in chat.messages" :key="item.id" class="message-row" :class="item.role">
        <div class="message-stack">
          <div class="message-body" :class="{ error: item.isError }">
            <template v-for="(block, blockIndex) in item.blocks" :key="`${item.id}-${blockIndex}`">
              <p v-if="item.role === 'user' && block.type === 'text'" class="user-message-text">{{ block.text }}</p>
              <MarkdownContent v-else-if="block.type === 'text'" :content="block.text" />
              <details v-else-if="block.type === 'thinking'" class="trace-block thinking-block">
                <summary><UiIcon name="spark" :size="15" />Thinking</summary>
                <p>{{ block.thinking }}</p>
              </details>
              <details v-else-if="block.type === 'tool_use'" class="trace-block tool-use-block">
                <summary><UiIcon name="cube" :size="15" />调用 {{ block.toolName }}</summary>
                <pre>{{ formatToolInput(block) }}</pre>
              </details>
              <details v-else-if="block.type === 'tool_result'" class="trace-block tool-result-block" :class="{ failed: block.isError }">
                <summary><UiIcon name="check" :size="15" />工具结果</summary>
                <pre>{{ block.content }}</pre>
              </details>
              <p v-else-if="block.type === 'error'" class="structured-error">{{ block.message }}</p>
            </template>
            <div v-if="item.contextUsage" class="context-usage">
              <span>上下文 {{ item.contextUsage.usedTokens.toLocaleString() }} / {{ item.contextUsage.maxTokens.toLocaleString() }} tokens</span>
              <i><b :style="{ width: `${contextPercentage(item)}%` }"></b></i>
            </div>
            <small v-if="item.tokenUsage || item.durationMs" class="token-usage">
              {{ item.model || 'Agent' }}
              <template v-if="item.tokenUsage"> · {{ item.tokenUsage.input + item.tokenUsage.output }} tokens<span v-if="item.tokenUsage.costUsd !== undefined"> · ${{ item.tokenUsage.costUsd.toFixed(4) }}</span></template>
              <template v-if="item.durationMs"> · {{ formatDuration(item.durationMs) }}</template>
            </small>
          </div>
          <div class="message-actions">
            <time :datetime="new Date(item.createdAt).toISOString()">{{ formatMessageTime(item.createdAt) }}</time>
            <button type="button" :aria-label="copiedMessageId === item.id ? '已复制' : '复制消息'" :title="copiedMessageId === item.id ? '已复制' : '复制消息'" @click="copyMessage(item.id, messageText(item))">
              <UiIcon :name="copiedMessageId === item.id ? 'check' : 'copy'" :size="15" />
            </button>
          </div>
        </div>
      </article>

      <article v-if="chat.streamingContent || chat.activity" class="message-row assistant streaming">
        <div class="message-stack">
          <div class="message-body">
            <MarkdownContent v-if="chat.streamingContent" :content="chat.streamingContent" streaming />
            <span v-else class="typing-dots" aria-label="蚂蚁正在回复"><i></i><i></i><i></i></span>
            <div v-if="chat.activity" class="agent-activity"><UiIcon :name="chat.activity.kind === 'tool' ? 'cube' : 'spark'" :size="16" />{{ chat.activity.label }}</div>
          </div>
        </div>
      </article>
    </div>

    <div class="chat-composer-wrap">
      <p v-if="chat.error" class="chat-error">{{ chat.error }}</p>
      <div class="composer">
        <textarea v-model="message" rows="3" placeholder="给蚂蚁发送消息，Enter 发送，Shift+Enter 换行" @keydown="handleKeydown"></textarea>
        <div class="composer-tools">
          <button type="button" aria-label="添加附件" title="附件功能即将开放" disabled><UiIcon name="clip" /></button>
          <span v-if="chat.config" class="composer-context">{{ chat.config.model }} · {{ chat.config.cwd }}</span>
          <button v-if="chat.isRunning" class="stop-button" type="button" aria-label="停止" @click="chat.cancel">停止</button>
          <button v-else class="send-button" type="button" aria-label="发送" :disabled="!message.trim() || sending" @click="submit"><UiIcon name="send" /></button>
        </div>
      </div>
    </div>
  </section>
</template>
