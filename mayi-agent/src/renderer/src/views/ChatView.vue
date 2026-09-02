<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import MarkdownContent from '@/components/MarkdownContent.vue'
import UiIcon from '@/components/UiIcon.vue'
import { useChatStore } from '@/stores/chat'
import { useSkillsStore } from '@/stores/skills'
import type { ChatMessage, ContentBlock, MessageAttachment } from '../../../shared/protocol'

const chat = useChatStore()
const skills = useSkillsStore()
const message = ref('')
const sending = ref(false)
const copiedMessageId = ref<string | null>(null)
const messageList = ref<HTMLElement | null>(null)
const pendingAttachments = ref<MessageAttachment[]>([])
const pendingSessionId = ref<string | null>(null)
const importingAttachments = ref(false)
const attachmentError = ref('')
const dragActive = ref(false)
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

watch(
  () => chat.activeSessionId,
  async (sessionId) => {
    if (!pendingSessionId.value || sessionId === pendingSessionId.value) return
    const stale = [...pendingAttachments.value]
    pendingAttachments.value = []
    pendingSessionId.value = null
    await Promise.all(stale.map((attachment) => window.mayi.attachments.discard(attachment.id).catch(() => undefined)))
  }
)

/** 将快捷技能名称预填入输入框，保留用户继续补充需求的空间。 */
function useSkill(id: string, displayName: string): void {
  message.value = `请使用 ${id}（${displayName}）技能帮我：`
}

/** 防止 IPC 提交阶段重复发送，并在成功提交后清空输入。 */
async function submit(): Promise<void> {
  const prompt = message.value.trim()
  if ((!prompt && pendingAttachments.value.length === 0) || sending.value || importingAttachments.value) return
  sending.value = true
  try {
    const sent = await chat.send(prompt, pendingAttachments.value.map((attachment) => attachment.id))
    if (sent) {
      message.value = ''
      pendingAttachments.value = []
      pendingSessionId.value = null
      attachmentError.value = ''
    }
  } finally {
    sending.value = false
  }
}

/** 打开原生文件选择器，所有文件都由主进程复制和验证。 */
async function chooseAttachments(): Promise<void> {
  if (importingAttachments.value || pendingAttachments.value.length >= 10) return
  importingAttachments.value = true
  attachmentError.value = ''
  const createdDraft = !chat.activeSessionId
  try {
    const sessionId = await chat.ensureDraftSession()
    const attachments = await window.mayi.attachments.select(sessionId)
    await appendAttachments(attachments)
    if (attachments.length > 0) pendingSessionId.value = sessionId
    if (createdDraft && attachments.length === 0) {
      await chat.deleteSession(sessionId)
      await chat.createNewSession()
    }
  } catch (reason) {
    attachmentError.value = reason instanceof Error ? reason.message : String(reason)
    if (createdDraft && chat.activeSessionId && pendingAttachments.value.length === 0) {
      await chat.deleteSession(chat.activeSessionId).catch(() => undefined)
      await chat.createNewSession()
    }
  } finally {
    importingAttachments.value = false
  }
}

/** 导入拖拽文件；真实路径只在 preload 中短暂解析。 */
async function handleDrop(event: DragEvent): Promise<void> {
  dragActive.value = false
  const files = Array.from(event.dataTransfer?.files || [])
  if (files.length === 0) return
  importingAttachments.value = true
  attachmentError.value = ''
  try {
    const sessionId = await chat.ensureDraftSession()
    await appendAttachments(await window.mayi.attachments.importFiles(sessionId, files))
    if (pendingAttachments.value.length > 0) pendingSessionId.value = sessionId
  } catch (reason) {
    attachmentError.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    importingAttachments.value = false
  }
}

/** 普通文本粘贴保持浏览器默认行为，只接管剪贴板图片。 */
async function handlePaste(event: ClipboardEvent): Promise<void> {
  const images = Array.from(event.clipboardData?.files || []).filter((file) => file.type.startsWith('image/'))
  if (images.length === 0) return
  event.preventDefault()
  importingAttachments.value = true
  attachmentError.value = ''
  const imported: MessageAttachment[] = []
  try {
    const sessionId = await chat.ensureDraftSession()
    for (const [index, file] of images.entries()) {
      const bytes = new Uint8Array(await file.arrayBuffer())
      imported.push(await window.mayi.attachments.importBytes({
        sessionId,
        name: file.name || `clipboard-image-${index + 1}.png`,
        mimeType: file.type,
        bytes
      }))
    }
    await appendAttachments(imported)
    if (imported.length > 0) pendingSessionId.value = sessionId
  } catch (reason) {
    await Promise.all(imported.map((attachment) => window.mayi.attachments.discard(attachment.id).catch(() => undefined)))
    attachmentError.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    importingAttachments.value = false
  }
}

/** 合并附件并执行界面侧数量上限，主进程仍会独立校验。 */
async function appendAttachments(attachments: MessageAttachment[]): Promise<void> {
  const remaining = 10 - pendingAttachments.value.length
  if (attachments.length > remaining) {
    attachmentError.value = '每条消息最多添加 10 个附件'
    await Promise.all(attachments.slice(remaining).map((attachment) => window.mayi.attachments.discard(attachment.id)))
  }
  pendingAttachments.value.push(...attachments.slice(0, remaining))
}

/** 删除尚未发送的附件副本。 */
async function removeAttachment(attachment: MessageAttachment): Promise<void> {
  try {
    await window.mayi.attachments.discard(attachment.id)
    pendingAttachments.value = pendingAttachments.value.filter((item) => item.id !== attachment.id)
    if (pendingAttachments.value.length === 0) pendingSessionId.value = null
  } catch (reason) {
    attachmentError.value = reason instanceof Error ? reason.message : String(reason)
  }
}

/** 请求主进程按附件 ID 在资源管理器中定位受控副本。 */
async function revealAttachment(attachmentId: string): Promise<void> {
  try {
    await window.mayi.attachments.reveal(attachmentId)
  } catch (reason) {
    attachmentError.value = reason instanceof Error ? reason.message : String(reason)
  }
}

/** 将字节数格式化为附件卡片使用的紧凑文本。 */
function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
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
      if (block.type === 'attachment') return `${block.attachment.name}\n${block.attachment.relativePath}`
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
          <span><strong>{{ skill.displayName }}</strong><small :title="skill.description">{{ skill.description }}</small></span>
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
              <button v-else-if="block.type === 'attachment'" type="button" class="message-attachment" @click="revealAttachment(block.attachment.id)">
                <UiIcon :name="block.attachment.kind === 'image' ? 'image' : 'file'" :size="20" />
                <span><strong>{{ block.attachment.name }}</strong><small>{{ block.attachment.mimeType }} · {{ formatFileSize(block.attachment.size) }}</small></span>
              </button>
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
      <p v-if="chat.error || attachmentError" class="chat-error">{{ attachmentError || chat.error }}</p>
      <div
        class="composer"
        :class="{ 'drag-active': dragActive }"
        @dragenter.prevent="dragActive = true"
        @dragover.prevent="dragActive = true"
        @dragleave.prevent="dragActive = false"
        @drop.prevent="handleDrop"
      >
        <div v-if="pendingAttachments.length" class="pending-attachments">
          <div v-for="attachment in pendingAttachments" :key="attachment.id" class="pending-attachment">
            <UiIcon :name="attachment.kind === 'image' ? 'image' : 'file'" :size="18" />
            <span><strong>{{ attachment.name }}</strong><small>{{ formatFileSize(attachment.size) }}</small></span>
            <button type="button" :aria-label="`移除 ${attachment.name}`" @click="removeAttachment(attachment)"><UiIcon name="close" :size="14" /></button>
          </div>
        </div>
        <textarea v-model="message" rows="3" placeholder="给蚂蚁发送消息，支持拖入文件或粘贴图片" @keydown="handleKeydown" @paste="handlePaste"></textarea>
        <div class="composer-tools">
          <button type="button" aria-label="添加附件" title="添加附件" :disabled="importingAttachments || pendingAttachments.length >= 10" @click="chooseAttachments"><UiIcon name="clip" /></button>
          <span v-if="chat.config" class="composer-context">{{ chat.config.model }} · {{ chat.config.cwd }}</span>
          <button v-if="chat.isRunning" class="stop-button" type="button" aria-label="停止" @click="chat.cancel">停止</button>
          <button v-else class="send-button" type="button" aria-label="发送" :disabled="(!message.trim() && !pendingAttachments.length) || sending || importingAttachments" @click="submit"><UiIcon name="send" /></button>
        </div>
      </div>
    </div>
  </section>
</template>
