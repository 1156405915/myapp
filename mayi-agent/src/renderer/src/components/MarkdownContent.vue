<script setup lang="ts">
import DOMPurify from 'dompurify'
import MarkdownIt from 'markdown-it'
import { computed } from 'vue'

const props = withDefaults(defineProps<{ content: string; streaming?: boolean }>(), {
  streaming: false
})

const markdown = new MarkdownIt({
  breaks: true,
  html: false,
  linkify: true,
  typographer: false
})

// 所有 Markdown 链接都交由主进程打开，避免当前渲染页获得外部页面上下文。
const defaultLinkOpen = markdown.renderer.rules.link_open
markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  tokens[index].attrSet('target', '_blank')
  tokens[index].attrSet('rel', 'noopener noreferrer')
  return defaultLinkOpen ? defaultLinkOpen(tokens, index, options, env, self) : self.renderToken(tokens, index, options)
}

/** 将禁用原始 HTML 的 Markdown 渲染结果再次净化后提供给模板。 */
const renderedContent = computed(() =>
  DOMPurify.sanitize(markdown.render(props.content), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style'],
    FORBID_ATTR: ['style']
  })
)

/** 拦截净化后的 HTTP(S) 链接，并交由隔离浏览窗口处理。 */
function handleContentClick(event: MouseEvent): void {
  if (!(event.target instanceof Element)) return
  const link = event.target.closest('a')
  if (!link) return

  event.preventDefault()
  const href = link.getAttribute('href')
  if (href && /^https?:\/\//i.test(href)) void window.mayi.openExternal(href)
}
</script>

<template>
  <div class="prose-chat" :class="{ 'is-streaming': streaming }" @click="handleContentClick" v-html="renderedContent"></div>
</template>
