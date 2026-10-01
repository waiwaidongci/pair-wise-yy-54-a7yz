<script setup lang="ts">
import { computed } from 'vue'
import { useQuery } from '@vue/apollo-composable'
import { SCHEME_QUERY } from '../graphql'
import { useSchemeStore } from '../store/scheme'

const store = useSchemeStore()
const { result, loading, error } = useQuery(SCHEME_QUERY)
const deficitCount = computed(() => store.ledger.filter((row) => row.shortfall > 0).length)
const stats = computed(() => [
  { label: '施工阶段', value: store.scheme.stages.length, note: '退回阶段不入容量账' },
  { label: '半小时亏空窗口', value: deficitCount.value, note: '急救/公交保底后仍不足' },
  { label: '待处理/失效会签', value: `${store.scheme.comments.filter((i) => i.status === '待处理').length} / ${store.scheme.comments.filter((i) => i.status === '失效待重签').length}`, note: '阶段变更即失效重签' },
  { label: '容量账版本', value: `v${store.scheme.ledgerVersion}`, note: `方案 v${result.value?.scheme?.version ?? store.scheme.version}，改动即重算` },
])
function agencyNote(role: string) {
  const own = store.scheme.comments.filter((c) => c.unit === role)
  if (own.some((c) => c.status === '失效待重签')) return '会签因变更失效'
  if (own.some((c) => c.status === '待处理')) return `${own.filter((c) => c.status === '待处理').length} 条待处理`
  if (own.some((c) => c.status === '已接受')) return '条件已接受并入账'
  return '暂无新增意见'
}
</script>

<template>
  <section class="page-head"><div><p class="eyebrow">建设 · 交通 · 公交 · 应急</p><h1>封路方案协调总览</h1><p>施工阶段、绕行路线、会签意见全部接到半小时道路容量账；急救通道与公交最低能力先留足。</p></div><a-space><a-button @click="$router.push('/review')">公开通告预览</a-button><a-button type="primary" @click="$router.push('/capacity')">进入容量账</a-button></a-space></section>
  <a-spin :loading="loading" style="width:100%">
    <a-alert v-if="error" type="error" title="GraphQL 请求异常，已使用本地草案" class="mb16" />
    <div class="metrics"><article v-for="item in stats" :key="item.label" class="card metric"><span>{{ item.label }}</span><strong>{{ item.value }}</strong><small>{{ item.note }}</small></article></div>

    <a-alert :type="store.gate.ready ? 'success' : 'error'" class="mb16" :title="store.gate.ready ? '容量账闸门放行，可导出公开通告' : '通告导出被挡住'">
      <template #default v-if="!store.gate.ready">
        <span v-for="(reason, i) in store.gate.reasons" :key="i" class="reason">· {{ reason }}　</span>
        <a-button size="mini" type="primary" style="margin-left:8px" @click="$router.push('/capacity')">去处理</a-button>
      </template>
    </a-alert>

    <div class="grid-2">
      <article class="card">
        <div class="panel-head"><div><h2>施工阶段时间轴</h2><p>点击阶段查看范围、共用路面与容量账</p></div><a-tag color="orange">容量账 v{{ store.scheme.ledgerVersion }}</a-tag></div>
        <a-table :data="store.scheme.stages" :pagination="false" row-key="id" @row-click="(row: any) => { store.selectedStageId = row.id; $router.push('/map') }">
          <template #columns><a-table-column title="阶段" data-index="name" /><a-table-column title="时间" :width="190"><template #cell="{ record }">{{ record.start }} → {{ record.end }}</template></a-table-column><a-table-column title="车道方案" data-index="lanes" /><a-table-column title="状态" :width="100"><template #cell="{ record }"><a-tag :color="record.status === '已批准' ? 'green' : record.status === '退回' ? 'red' : 'orange'">{{ record.status }}</a-tag></template></a-table-column></template></a-table>
      </article>
      <article class="card">
        <div class="panel-head"><div><h2>容量账检测结果</h2><p>按影响等级排序，来源精确到路链与单号</p></div><a-tag color="red">{{ store.conflicts.filter((item) => item.level === '高').length }} 高风险</a-tag></div>
        <div v-for="item in store.conflicts" :key="item.id" class="conflict" :class="item.level === '高' ? 'red' : 'amber'"><div><b>{{ item.title }}</b><small>{{ item.segmentId }}</small></div><a-tag :color="item.level === '高' ? 'red' : 'orange'">{{ item.level }}</a-tag><p>{{ item.detail }}</p><a-button size="mini" type="text" @click="$router.push('/capacity')">查容量账</a-button></div>
      </article>
    </div>
    <article class="card mt16"><div class="panel-head"><div><h2>会签单位与条件</h2><p>意见锚定具体分段，原记录不覆盖；变更失效后须重签</p></div><a-button type="text" @click="$router.push('/review')">进入会签</a-button></div><div class="agency-grid"><div v-for="agency in result?.agencies || []" :key="agency.id" class="agency"><span>{{ agency.role }}</span><div><b>{{ agency.name }}</b><small>{{ agencyNote(agency.role) }}</small></div><a-tag :color="agencyNote(agency.role).includes('待处理') || agencyNote(agency.role).includes('失效') ? 'orange' : 'green'">{{ agencyNote(agency.role).includes('待处理') || agencyNote(agency.role).includes('失效') ? '待办' : '已响应' }}</a-tag></div></div></article>
  </a-spin>
</template>

<style scoped>
.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:16px}.metric{padding:17px;border-left:4px solid #2563eb}.metric span,.metric small{display:block;color:#667085}.metric strong{display:block;font-size:29px;margin:7px 0 2px}.grid-2{display:grid;grid-template-columns:1.3fr .9fr;gap:16px}.panel-head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px}.panel-head h2{font-size:17px;margin:0 0 4px}.panel-head p{color:#7a8798;font-size:13px;margin:0}.reason{color:#b42318;font-size:13px}.conflict{display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;padding:12px;margin-bottom:9px;border-radius:6px}.conflict.red{background:#fff1f2;border-left:3px solid #e11d48}.conflict.amber{background:#fff7ed;border-left:3px solid #f59e0b}.conflict>div{min-width:210px}.conflict b,.conflict small{display:block}.conflict small{color:#7a8798;margin-top:3px}.conflict p{width:100%;margin:0;color:#475569;font-size:13px;line-height:1.5}.mt16{margin-top:16px}.agency-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.agency{display:flex;align-items:center;gap:10px;padding:12px;border:1px solid #e7ebf1;border-radius:7px}.agency>span{display:grid;place-items:center;width:35px;height:35px;border-radius:7px;background:#eff6ff;color:#2563eb;font-weight:800}.agency b,.agency small{display:block}.agency small{color:#7a8798;margin-top:3px}.agency>div{flex:1}
@media(max-width:1050px){.metrics,.agency-grid{grid-template-columns:1fr 1fr}.grid-2{grid-template-columns:1fr}}@media(max-width:600px){.metrics,.agency-grid{grid-template-columns:1fr}}
</style>
