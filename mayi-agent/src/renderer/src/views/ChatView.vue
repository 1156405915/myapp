<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import UiIcon from '@/components/UiIcon.vue'
import { useChatStore } from '@/stores/chat'

const chat = useChatStore()
const message = ref('')
const sending = ref(false)
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

onMounted(() => void chat.initialize())

watch(
  () => [chat.messages.length, chat.streamingContent],
  async () => {
    await nextTick()
    messageList.value?.scrollTo({ top: messageList.value.scrollHeight, behavior: 'smooth' })
  }
)

function useSkill(title: string): void {
  message.value = `请帮我使用“${title}”技能：`
}

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

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    void submit()
  }
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
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
        <div class="message-avatar">{{ item.role === 'user' ? '你' : '蚁' }}</div>
        <div class="message-body" :class="{ error: item.isError }">
          <div class="message-meta"><strong>{{ item.role === 'user' ? '你' : '蚂蚁' }}</strong><time>{{ formatTime(item.createdAt) }}</time></div>
          <p>{{ item.content }}</p>
          <small v-if="item.tokenUsage" class="token-usage">{{ item.model || 'Claude' }} · {{ item.tokenUsage.input + item.tokenUsage.output }} tokens<span v-if="item.tokenUsage.costUsd !== undefined"> · ${{ item.tokenUsage.costUsd.toFixed(4) }}</span></small>
        </div>
      </article>

      <article v-if="chat.streamingContent || chat.activity" class="message-row assistant streaming">
        <div class="message-avatar">蚁</div>
        <div class="message-body">
          <div class="message-meta"><strong>蚂蚁</strong><span class="typing-dots"><i></i><i></i><i></i></span></div>
          <p v-if="chat.streamingContent">{{ chat.streamingContent }}</p>
          <div v-if="chat.activity" class="agent-activity"><UiIcon :name="chat.activity.kind === 'tool' ? 'cube' : 'spark'" :size="16" />{{ chat.activity.label }}</div>
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
