<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import MarkdownContent from '@/components/MarkdownContent.vue'
import UiIcon from '@/components/UiIcon.vue'
import { useChatStore } from '@/stores/chat'

const chat = useChatStore()
const message = ref('')
const sending = ref(false)
const copiedMessageId = ref<string | null>(null)
const messageList = ref<HTMLElement | null>(null)
const skills = [
  { icon: 'file', title: '文档总结', description: '快速提炼重点' },
  { icon: 'code', title: '代码解释', description: '解读并解释代码' },
  { icon: 'web', title: '网页检索', description: '联网查找信息' },
  { icon: 'presentation', title: '生成PPT', description: '智能生成演示文稿' },
  { icon: 'table', title: '表格分析', description: '数据洞察与分析' },
  { icon: 'flow', title: '流程图', description: '生成流程图示' },
  { icon: 'note', title: '会议纪要', description: '整理会议要点' },
  { icon: 'translate', title: '翻译润色', description: '翻译与润色优化' }
]

// ChatView 可能晚于布局挂载，store 会避免重复初始化和重复监听。
onMounted(() => void chat.initialize())

// 仅观察影响列表高度的数据，并等待 DOM 更新后再滚动。
watch(
  () => [chat.messages.length, chat.streamingContent],
  async () => {
    await nextTick()
    messageList.value?.scrollTo({ top: messageList.value.scrollHeight, behavior: 'smooth' })
  }
)

/** 将快捷技能名称预填入输入框，保留用户继续补充需求的空间。 */
function useSkill(title: string): void {
  message.value = `请帮我使用“${title}”技能：`
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

</script>

<template>
  <section class="page chat-page" :class="{ 'has-messages': chat.messages.length > 0 || chat.streamingContent }">
    <div v-if="chat.messages.length === 0 && !chat.streamingContent" class="chat-empty">
      <div class="welcome-copy">
        <h1>今天想完成什么？</h1>
        <p>蚂蚁可以阅读项目文件、修改代码、检索资料并完成复杂任务。</p>
      </div>
      <div class="skill-heading">常用技能</div>
      <div class="skill-shortcuts">
        <button v-for="skill in skills" :key="skill.title" type="button" @click="useSkill(skill.title)">
          <UiIcon :name="skill.icon" :size="34" />
          <span><strong>{{ skill.title }}</strong><small>{{ skill.description }}</small></span>
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
            <p v-if="item.role === 'user'" class="user-message-text">{{ item.content }}</p>
            <MarkdownContent v-else :content="item.content" />
            <small v-if="item.tokenUsage" class="token-usage">{{ item.model || 'Claude' }} · {{ item.tokenUsage.input + item.tokenUsage.output }} tokens<span v-if="item.tokenUsage.costUsd !== undefined"> · ${{ item.tokenUsage.costUsd.toFixed(4) }}</span></small>
          </div>
          <div class="message-actions">
            <time :datetime="new Date(item.createdAt).toISOString()">{{ formatMessageTime(item.createdAt) }}</time>
            <button type="button" :aria-label="copiedMessageId === item.id ? '已复制' : '复制消息'" :title="copiedMessageId === item.id ? '已复制' : '复制消息'" @click="copyMessage(item.id, item.content)">
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
