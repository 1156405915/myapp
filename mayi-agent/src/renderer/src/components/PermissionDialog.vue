<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { PermissionDecision, PermissionRequest } from '../../../shared/protocol'

const props = defineProps<{ permission: PermissionRequest; busy?: boolean }>()
const emit = defineEmits<{ respond: [decision: PermissionDecision] }>()
const confirmingAlways = ref(false)

/** 标识会执行命令或修改文件的高风险工具。 */
const isHighRisk = computed(() => ['Bash', 'Write', 'Edit'].includes(props.permission.toolName))
/** 将 SDK 工具名称转换为用户可理解的操作名称。 */
const actionName = computed(() => {
  if (props.permission.displayName) return props.permission.displayName
  if (props.permission.toolName === 'Bash') return '执行终端命令'
  if (props.permission.toolName === 'Write') return '写入文件'
  if (props.permission.toolName === 'Edit') return '修改文件'
  return `使用 ${props.permission.toolName}`
})
/** 序列化权限输入并限制弹窗中的最大展示长度。 */
const inputText = computed(() => {
  const command = props.permission.input.command
  const content = typeof command === 'string' ? command : JSON.stringify(props.permission.input, null, 2)
  return content.length > 12_000 ? `${content.slice(0, 12_000)}\n…内容过长，已截断` : content
})

// 新权限请求不能继承上一请求的“始终允许”二次确认状态。
watch(
  () => props.permission.toolUseId,
  () => {
    confirmingAlways.value = false
  }
)

/** 对高风险的永久授权执行二次确认，其余决策直接提交。 */
function respond(decision: PermissionDecision): void {
  if (props.busy) return
  if (decision === 'allow-always' && isHighRisk.value && !confirmingAlways.value) {
    confirmingAlways.value = true
    return
  }
  emit('respond', decision)
}
</script>

<template>
  <div class="permission-backdrop">
    <section class="permission-dialog" role="alertdialog" aria-modal="true" aria-labelledby="permission-title">
      <header>
        <span class="permission-mark">!</span>
        <div>
          <small>工具权限请求</small>
          <h2 id="permission-title">{{ permission.title || actionName }}</h2>
          <p>{{ permission.description || 'Agent 需要获得你的允许才能继续执行。' }}</p>
        </div>
      </header>

      <div v-if="isHighRisk" class="permission-warning">
        此操作可能修改文件或执行系统命令，请确认内容和工作目录可信。
      </div>

      <div class="permission-details">
        <div><span>工具</span><strong>{{ permission.toolName }}</strong></div>
        <div v-if="permission.blockedPath"><span>路径</span><strong>{{ permission.blockedPath }}</strong></div>
        <div v-if="permission.decisionReason"><span>原因</span><strong>{{ permission.decisionReason }}</strong></div>
      </div>

      <pre><code>{{ inputText }}</code></pre>

      <p v-if="confirmingAlways" class="always-confirmation">
        确认后，本会话后续匹配的操作可能不再询问。
      </p>

      <footer>
        <button type="button" :disabled="busy" @click="respond('deny')">拒绝</button>
        <button type="button" class="allow-once" :disabled="busy" @click="respond('allow-once')">
          允许一次
        </button>
        <button
          v-if="permission.canAlwaysAllow"
          type="button"
          class="allow-always"
          :class="{ confirming: confirmingAlways }"
          :disabled="busy"
          @click="respond('allow-always')"
        >
          {{ confirmingAlways ? '确认始终允许' : '本会话始终允许' }}
        </button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.permission-backdrop { position: fixed; z-index: 300; inset: 0; display: grid; place-items: center; padding: 24px; background: rgba(15, 26, 23, .42); backdrop-filter: blur(5px); }
.permission-dialog { width: min(620px, 100%); max-height: min(760px, calc(100vh - 48px)); padding: 24px; overflow-y: auto; border: 1px solid #dce5e1; border-radius: 18px; background: #fff; box-shadow: 0 28px 80px rgba(22, 45, 37, .24); }
.permission-dialog header { display: grid; grid-template-columns: 42px 1fr; gap: 14px; align-items: start; }
.permission-mark { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 12px; color: #9a5b13; background: #fff1d8; font-size: 22px; font-weight: 800; }
.permission-dialog header small { color: #718099; font-size: 12px; }
.permission-dialog h2 { margin: 4px 0 6px; color: #16233a; font-size: 21px; line-height: 1.35; }
.permission-dialog header p { margin: 0; color: #516079; font-size: 14px; line-height: 1.55; }
.permission-warning,.always-confirmation { margin: 18px 0 0; padding: 11px 13px; border: 1px solid #f0d5a9; border-radius: 10px; color: #7a4a12; background: #fff9ef; font-size: 13px; line-height: 1.55; }
.permission-details { display: grid; gap: 8px; margin-top: 18px; }
.permission-details div { display: grid; grid-template-columns: 58px minmax(0,1fr); gap: 10px; font-size: 13px; }
.permission-details span { color: #718099; }
.permission-details strong { overflow-wrap: anywhere; color: #263650; font-weight: 600; }
.permission-dialog pre { max-height: 320px; margin: 18px 0 0; padding: 15px 16px; overflow: auto; border: 1px solid #263449; border-radius: 11px; background: #172033; color: #eef5f2; white-space: pre-wrap; overflow-wrap: anywhere; }
.permission-dialog code { font-family: Consolas, "SFMono-Regular", monospace; font-size: 13px; line-height: 1.6; }
.permission-dialog footer { display: flex; justify-content: flex-end; gap: 9px; margin-top: 22px; }
.permission-dialog footer button { min-height: 42px; padding: 0 16px; border: 1px solid #d6dee4; border-radius: 10px; background: #fff; cursor: pointer; }
.permission-dialog footer button:disabled { opacity: .55; cursor: wait; }
.permission-dialog .allow-once { border-color: #2b9677; color: #fff; background: #2b9677; }
.permission-dialog .allow-always { color: #1f8065; border-color: #b9dcd0; background: #f2faf7; }
.permission-dialog .allow-always.confirming { color: #fff; border-color: #b36b18; background: #b36b18; }
</style>
