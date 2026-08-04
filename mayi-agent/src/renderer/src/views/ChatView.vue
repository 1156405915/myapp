<script setup lang="ts">
import { ref } from 'vue'
import UiIcon from '@/components/UiIcon.vue'

const message = ref('')
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

function useSkill(title: string): void {
  message.value = `请帮我使用“${title}”技能：`
}
</script>

<template>
  <section class="page chat-page">
    <div class="chat-empty">
      <div class="skill-heading">常用技能</div>
      <div class="skill-shortcuts">
        <button v-for="skill in skills" :key="skill.title" type="button" @click="useSkill(skill.title)">
          <UiIcon :name="skill.icon" :size="34" />
          <span><strong>{{ skill.title }}</strong><small>{{ skill.description }}</small></span>
        </button>
      </div>

      <div class="composer">
        <textarea v-model="message" rows="3" placeholder="给蚂蚁发送消息"></textarea>
        <div class="composer-tools">
          <button type="button" aria-label="添加附件"><UiIcon name="clip" /></button>
          <button type="button" aria-label="提及"><UiIcon name="at" /></button>
          <button class="send-button" type="button" aria-label="发送"><UiIcon name="send" /></button>
        </div>
      </div>
    </div>
  </section>
</template>
