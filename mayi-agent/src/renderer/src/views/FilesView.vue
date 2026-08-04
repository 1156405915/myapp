<script setup lang="ts">
import { ref } from 'vue'
import UiIcon from '@/components/UiIcon.vue'

const selected = ref('产品需求文档 V2.0.docx')
const files = [
  ['项目资料', '文件夹', '2026-08-04 14:30', '—', 'folder'],
  ['产品需求文档 V2.0.docx', '文档', '2026-08-04 11:20', '2.4 MB', 'file'],
  ['功能清单.xlsx', '表格', '2026-08-04 10:15', '324 KB', 'table'],
  ['项目进度汇报.pptx', '演示文稿', '2026-08-03 16:45', '5.1 MB', 'presentation'],
  ['用户研究报告.pdf', 'PDF', '2026-08-03 15:30', '1.8 MB', 'file'],
  ['界面设计稿.png', '图片', '2026-08-02 18:20', '2.7 MB', 'file'],
  ['数据处理脚本.py', '代码', '2026-08-02 14:10', '12 KB', 'code'],
  ['会议记录', '文件夹', '2026-08-01 09:50', '—', 'folder']
]
</script>

<template>
  <section class="page files-page">
    <div class="files-toolbar"><label class="search-box"><UiIcon name="search" /><input placeholder="搜索文件名、内容或标签" /></label><div class="segmented"><button class="active">全部</button><button>文档</button><button>表格</button><button>图片</button><button>代码</button><button>最近访问</button></div><button class="upload-button"><UiIcon name="upload" />上传文件</button><button><UiIcon name="folder" />新建文件夹</button></div>
    <div class="files-body">
      <section class="file-list panel-card"><h3>全部文件</h3><div class="file-table-head"><span>名称</span><span>类型</span><span>修改时间</span><span>大小</span></div><button v-for="file in files" :key="file[0]" class="file-row" :class="{ active: selected === file[0] }" type="button" @click="selected = file[0]"><input type="checkbox" :checked="selected === file[0]" @click.stop /><span class="file-name"><i><UiIcon :name="file[4]" /></i><strong>{{ file[0] }}</strong></span><span>{{ file[1] }}</span><time>{{ file[2] }}</time><span>{{ file[3] }}</span><UiIcon name="more" /></button><footer>共 32 项 <span>‹</span><b>1</b><span>2</span><span>3</span><span>4</span><span>›</span></footer></section>
      <aside class="file-detail panel-card"><header><span class="doc-icon">W</span><div><strong>{{ selected }}</strong><small>DOCX 文档 · 2.4 MB</small></div><UiIcon name="close" /></header><div class="file-actions"><button>预览</button><button>下载</button><button>分享</button><button><UiIcon name="more" /></button></div><h4>基本信息</h4><dl><div><dt>位置</dt><dd>/项目资料/产品文档</dd></div><div><dt>创建时间</dt><dd>2026-08-01 10:30</dd></div><div><dt>修改时间</dt><dd>2026-08-04 11:20</dd></div><div><dt>创建者</dt><dd>zhangsan</dd></div><div><dt>标签</dt><dd><em>产品</em><em>需求文档</em></dd></div></dl><h4>描述</h4><p>产品需求文档，包含功能需求、非功能需求、用户角色和流程图等内容。</p><h4>最近访问</h4><ul><li><span>Z</span>zhangsan<time>2026-08-04 11:20</time></li><li><span>L</span>lisi<time>2026-08-04 10:15</time></li><li><span>W</span>wangwu<time>2026-08-03 16:45</time></li></ul></aside>
    </div>
  </section>
</template>
