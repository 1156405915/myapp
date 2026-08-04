<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import AntLogo from '@/components/AntLogo.vue'
import UiIcon from '@/components/UiIcon.vue'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const auth = useAuthStore()
const activeTab = ref<'account' | 'code'>('account')
const identifier = ref('')
const password = ref('')
const phone = ref('')
const verificationCode = ref('')
const remember = ref(true)
const showPassword = ref(false)
const submitting = ref(false)
const error = ref('')

const canSubmit = computed(() => {
  if (activeTab.value === 'account') {
    return Boolean(identifier.value.trim()) && password.value.length >= 6
  }
  return phone.value.trim().length >= 8 && verificationCode.value.trim().length >= 4
})

async function submit(): Promise<void> {
  error.value = ''
  submitting.value = true
  try {
    if (activeTab.value === 'account') {
      await auth.login(identifier.value, password.value)
    } else {
      await auth.login(phone.value || 'mobile-user', verificationCode.value.padEnd(6, '0'))
    }
    await router.push('/chat')
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '登录失败，请稍后重试'
  } finally {
    submitting.value = false
  }
}

async function loginWithProvider(provider: string): Promise<void> {
  submitting.value = true
  error.value = ''
  try {
    await auth.loginWithProvider(provider)
    await router.push('/chat')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="login-page">
    <section class="login-story">
      <div class="login-brand">
        <AntLogo :size="54" />
        <div>
          <strong>蚂蚁</strong>
          <span>企业级 AI 协作平台</span>
        </div>
      </div>

      <div class="story-copy">
        <h1>让 AI 协作，<br />更高效地发生</h1>
        <p>连接人与知识、工具与流程，<br />打造企业专属的智能协作中枢。</p>
      </div>

      <div class="story-features">
        <article>
          <span class="feature-icon"><UiIcon name="chat" /></span>
          <div><strong>统一会话协作</strong><p>多轮对话与知识沉淀，让团队信息不再分散。</p></div>
        </article>
        <article>
          <span class="feature-icon"><UiIcon name="cube" /></span>
          <div><strong>MCP 工具接入</strong><p>灵活接入内外部工具与服务，扩展 AI 能力边界。</p></div>
        </article>
        <article>
          <span class="feature-icon"><UiIcon name="folder" /></span>
          <div><strong>技能与文件库管理</strong><p>沉淀企业知识与最佳实践，让回答更专业可信。</p></div>
        </article>
      </div>

      <div class="story-visual" aria-hidden="true">
        <div class="visual-platform"></div>
        <div class="visual-card card-a"><UiIcon name="chat" :size="28" /></div>
        <div class="visual-card card-b"><UiIcon name="file" :size="28" /></div>
        <div class="visual-card card-c"><UiIcon name="cube" :size="28" /></div>
      </div>
    </section>

    <section class="login-panel-wrap">
      <div class="login-panel">
        <div class="language-select"><UiIcon name="globe" :size="17" />简体中文<UiIcon name="down" :size="15" /></div>

        <div class="login-tabs" role="tablist">
          <button :class="{ active: activeTab === 'account' }" type="button" @click="activeTab = 'account'">账号登录</button>
          <button :class="{ active: activeTab === 'code' }" type="button" @click="activeTab = 'code'">验证码登录</button>
        </div>

        <form class="login-form" @submit.prevent="submit">
          <template v-if="activeTab === 'account'">
            <label class="field">
              <UiIcon name="mail" />
              <input v-model="identifier" autocomplete="username" placeholder="邮箱 / 用户名" />
            </label>
            <label class="field">
              <UiIcon name="lock" />
              <input v-model="password" :type="showPassword ? 'text' : 'password'" autocomplete="current-password" placeholder="密码" />
              <button class="field-action" type="button" aria-label="显示密码" @click="showPassword = !showPassword"><UiIcon name="eye" /></button>
            </label>
          </template>
          <template v-else>
            <label class="field">
              <UiIcon name="user" />
              <input v-model="phone" inputmode="tel" placeholder="手机号" />
            </label>
            <label class="field code-field">
              <UiIcon name="lock" />
              <input v-model="verificationCode" inputmode="numeric" placeholder="验证码" />
              <button class="send-code" type="button">获取验证码</button>
            </label>
          </template>

          <div class="login-options">
            <label class="remember"><input v-model="remember" type="checkbox" /><span>记住我</span></label>
            <button type="button">忘记密码</button>
          </div>

          <p v-if="error" class="form-error">{{ error }}</p>

          <button class="login-submit" type="submit" :disabled="!canSubmit || submitting">
            {{ submitting ? '正在登录…' : '登录' }}
          </button>
        </form>

        <div class="divider"><span>其他登录方式</span></div>
        <div class="provider-grid">
          <button type="button" @click="loginWithProvider('GitHub')"><b>GH</b>GitHub</button>
          <button type="button" @click="loginWithProvider('Google')"><b>G</b>Google</button>
          <button type="button" @click="loginWithProvider('WeCom')"><b>企</b>企业微信</button>
          <button type="button" @click="loginWithProvider('Feishu')"><b>飞</b>飞书</button>
        </div>

        <p class="register-copy">还没有账号？<button type="button">立即注册</button></p>
      </div>
      <footer class="login-footer"><span>数据加密传输</span><i></i><span>企业级安全保障</span><i></i><span>隐私政策</span></footer>
    </section>
  </div>
</template>
