<script setup lang="ts">
import { computed, ref } from 'vue'
import { useSchemeStore } from '../store/scheme'
import { useCapacityStore } from '../store/capacity'
import type { SubmitResult } from '../types'

const scheme = useSchemeStore()
const cap = useCapacityStore()

const selectedDate = ref('2026-10-08')
const roadFilter = ref<'all' | 'main' | 'dr-01' | 'dr-02'>('all')
const onlyActive = ref(true)
const recoverOrderNo = ref('')
const message = ref('')
const messageType = ref<'info' | 'success' | 'warning' | 'error'>('info')

function flash(text: string, type: 'info' | 'success' | 'warning' | 'error' = 'info') {
  message.value = text
  messageType.value = type
}

const dates = computed(() => {
  const set = new Set(cap.windows.map((w) => w.date))
  return [...set].sort()
})

const dayWindows = computed(() => cap.windows.filter((w) => {
  if (w.date !== selectedDate.value) return false
  if (roadFilter.value !== 'all' && w.roadId !== roadFilter.value) return false
  if (onlyActive.value) return cap.windowOccupations(w.windowId).length > 0 || cap.queuedEntries.some((q) => q.windowId === w.windowId)
  return true
}))

const metrics = computed(() => [
  { label: '半小时窗口', value: cap.windows.length, note: '42 天 × 48 窗口 × 3 路段' },
  { label: '已预占窗口', value: new Set(cap.validOccupations.map((o) => o.windowId)).size, note: '有效预占' },
  { label: '排队中', value: cap.queuedEntries.length, note: '容量不足等待放行' },
  { label: '容量预警窗口', value: cap.windows.filter((w) => w.date === selectedDate.value && (cap.windowStatus(w) === '紧张' || cap.windowStatus(w) === '排队')).length, note: '当日紧张/排队' },
])

const totalReserved = computed(() => cap.validOccupations.reduce((s, o) => s + o.amount, 0))

function summarize(results: SubmitResult[]): string {
  const admitted = results.filter((r) => r.outcome === 'admitted').length
  const queued = results.filter((r) => r.outcome === 'queued').length
  const conflict = results.filter((r) => r.outcome === 'conflict').length
  const duplicate = results.filter((r) => r.outcome === 'duplicate').length
  return `放行 ${admitted} · 排队 ${queued} · 冲突 ${conflict} · 重复 ${duplicate}`
}

function reserveStage(stageId: string) {
  const r = cap.submitReservation('stage', stageId)
  if (r.failed) {
    flash(`已模拟写入失败：现场单号 ${r.orderNo} 已登记，可在下方按单号恢复（不会重复占位）。`, 'warning')
  } else {
    flash(`阶段预占已提交（单号 ${r.orderNo}）：${summarize(r.results)}`, r.results.some((x) => x.outcome === 'queued') ? 'warning' : 'success')
  }
}
function reserveDetour(detourId: string) {
  const r = cap.submitReservation('detour', detourId)
  if (r.failed) {
    flash(`已模拟写入失败：现场单号 ${r.orderNo} 已登记，可按单号恢复。`, 'warning')
  } else {
    flash(`绕行预占已提交（单号 ${r.orderNo}）：${summarize(r.results)}`, r.results.some((x) => x.outcome === 'queued') ? 'warning' : 'success')
  }
}

function doRecover() {
  if (!recoverOrderNo.value.trim()) return
  const r = cap.recoverByOrderNo(recoverOrderNo.value.trim())
  if (r.status === 'not-found') flash(`未找到现场单号 ${recoverOrderNo.value} 的失败记录。`, 'error')
  else if (r.status === 'recovered-existing') flash(`按单号恢复：检测到已有预占 ${r.results?.length ?? 0} 笔，原样返回，未重复占位。`, 'success')
  else flash(`按单号恢复：补建预占 ${r.results?.length ?? 0} 笔，未重复占位。`, 'success')
  recoverOrderNo.value = ''
}

function runConcurrent() {
  const wid = '2026-10-08T09:00/09:30#main'
  cap.demoConcurrent(wid)
  flash(`两终端同时提交 ${wid}：终端 B 被窗口锁挡住（只放行一笔），终端 A 随后放行。`, 'warning')
}

const outcomeColor: Record<string, string> = { admitted: 'green', queued: 'orange', conflict: 'red', duplicate: 'blue' }
const outcomeLabel: Record<string, string> = { admitted: '放行', queued: '排队', conflict: '冲突', duplicate: '重复' }
</script>

<template>
  <section class="page-head compact">
    <div>
      <p class="eyebrow">半小时道路容量账</p>
      <h1>施工阶段 · 绕行路线 · 会签意见 容量联动</h1>
      <p>急救通道与公交最低能力先留足；容量不足时进入排队并指出占用来源。两终端同窗只放行一笔，写入失败按现场单号恢复。</p>
    </div>
    <a-space>
      <a-button :status="cap.simulateWriteFail ? 'danger' : undefined" @click="cap.simulateWriteFail = !cap.simulateWriteFail">
        {{ cap.simulateWriteFail ? '模拟写入失败：开' : '模拟写入失败：关' }}
      </a-button>
      <a-button @click="runConcurrent">模拟两终端同时提交同窗</a-button>
      <a-button type="primary" @click="cap.recalculateAll()">全部重算</a-button>
    </a-space>
  </section>

  <a-alert v-if="cap.exportBlocked" type="error" class="mb16" title="容量账重算中，通告导出已锁定" content="阶段时间或路线变更后，旧预占与会签正在失效重算；恢复前公开通告导出挡住，不得导出。" />
  <a-alert v-else-if="cap.recoveryState === 'recovered'" type="success" class="mb16" title="容量账已恢复" content="旧预占已失效并重算完成，会签意见已重新挂接，通告导出已放行。" />
  <a-alert v-if="message" :type="messageType" class="mb16" :title="message" />

  <div class="metrics">
    <article v-for="m in metrics" :key="m.label" class="card metric"><span>{{ m.label }}</span><strong>{{ m.value }}</strong><small>{{ m.note }}</small></article>
  </div>

  <div class="grid-2">
    <article class="card">
      <div class="panel-head"><div><h2>施工阶段预占</h2><p>按阶段时间 × 每日作业带 × 路段容量预占</p></div><a-tag color="orange">{{ scheme.scheme.stages.length }} 阶段</a-tag></div>
      <div v-for="stage in scheme.scheme.stages" :key="stage.id" class="reserve">
        <div><b>{{ stage.name }}</b><small>{{ stage.start }} → {{ stage.end }} · {{ stage.lanes }}</small></div>
        <a-space>
          <a-tag :color="stage.status === '已批准' ? 'green' : stage.status === '退回' ? 'red' : 'orange'">{{ stage.status }}</a-tag>
          <a-button size="small" type="primary" @click="reserveStage(stage.id)">发起预占</a-button>
        </a-space>
      </div>
      <a-divider />
      <div class="panel-head"><div><h2>绕行路线预占</h2><p>绕行路段容量与公交最低能力</p></div></div>
      <div v-for="detour in scheme.scheme.detours" :key="detour.id" class="reserve">
        <div><b>{{ detour.name }}</b><small>{{ detour.distance }} km · 增加 {{ detour.extraMinutes }} 分钟</small></div>
        <a-button size="small" type="primary" @click="reserveDetour(detour.id)">发起预占</a-button>
      </div>
    </article>

    <article class="card">
      <div class="panel-head"><div><h2>写入失败 · 按现场单号恢复</h2><p>恢复时幂等，不重复占位</p></div></div>
      <div v-if="cap.failedOrders.length === 0" class="empty">无失败单号。打开「模拟写入失败」后发起预占即可生成失败单号。</div>
      <div v-for="f in cap.failedOrders" :key="f.orderNo" class="failed">
        <div><b>{{ f.objectName }}</b><small>单号 {{ f.orderNo }} · {{ new Date(f.at).toLocaleTimeString() }}</small></div>
        <a-button size="small" @click="recoverOrderNo = f.orderNo; doRecover()">按此单号恢复</a-button>
      </div>
      <a-input v-model="recoverOrderNo" placeholder="或输入现场单号恢复" class="mt12" />
      <a-button type="primary" class="mt12" @click="doRecover()">按单号恢复</a-button>
      <a-divider />
      <div class="panel-head"><div><h2>终端提交日志</h2><p>同窗只放行一笔</p></div><a-button size="mini" type="text" @click="cap.clearTerminalLog()">清空</a-button></div>
      <div v-if="cap.terminalLog.length === 0" class="empty">暂无并发提交。点击右上角「模拟两终端同时提交同窗」。</div>
      <div v-for="(log, i) in cap.terminalLog" :key="i" class="log">
        <span>{{ log.terminal }}</span><small>{{ log.windowId }}</small>
        <a-tag :color="outcomeColor[log.outcome]">{{ outcomeLabel[log.outcome] }}</a-tag>
        <em>{{ log.orderNo }}</em>
      </div>
    </article>
  </div>

  <article class="card mt16">
    <div class="panel-head">
      <div><h2>半小时容量账</h2><p>急救通道与公交最低能力先留足；占用来源逐笔可查</p></div>
      <a-space>
        <a-select v-model="selectedDate" style="width:150px"><a-option v-for="d in dates" :key="d" :value="d">{{ d }}</a-option></a-select>
        <a-select v-model="roadFilter" style="width:170px">
          <a-option value="all">全部路段</a-option>
          <a-option value="main">云河路（施工段）</a-option>
          <a-option value="dr-01">江海大道—滨河路绕行</a-option>
          <a-option value="dr-02">云河路辅道保通</a-option>
        </a-select>
        <a-checkbox v-model="onlyActive">仅看占用/排队</a-checkbox>
      </a-space>
    </div>
    <a-table :data="dayWindows" :pagination="{ pageSize: 12 }" row-key="windowId" size="small">
      <template #columns>
        <a-table-column title="窗口" :width="170">
          <template #cell="{ record }"><b>{{ record.start }}–{{ record.end }}</b><small>{{ record.date }}</small></template>
        </a-table-column>
        <a-table-column title="路段" data-index="roadName" :width="180" />
        <a-table-column title="总容量" data-index="total" :width="90" />
        <a-table-column title="急救预留" data-index="reservedEmergency" :width="90">
          <template #cell="{ record }"><span v-if="record.reservedEmergency">{{ record.reservedEmergency }}</span><span v-else>—</span></template>
        </a-table-column>
        <a-table-column title="公交预留" data-index="reservedBus" :width="90" />
        <a-table-column title="已预占" :width="90">
          <template #cell="{ record }">{{ cap.occupiedAmount(record.windowId) }}</template>
        </a-table-column>
        <a-table-column title="可用" :width="90">
          <template #cell="{ record }"><b :class="{ low: cap.availableOf(record) < record.total * 0.15 }">{{ cap.availableOf(record) }}</b></template>
        </a-table-column>
        <a-table-column title="状态" :width="80">
          <template #cell="{ record }"><a-tag :color="cap.windowStatus(record) === '排队' ? 'red' : cap.windowStatus(record) === '紧张' ? 'orange' : 'green'">{{ cap.windowStatus(record) }}</a-tag></template>
        </a-table-column>
        <a-table-column title="占用来源">
          <template #cell="{ record }">
            <template v-if="cap.windowOccupations(record.windowId).length">
              <a-tag v-for="o in cap.windowOccupations(record.windowId)" :key="o.id" color="blue">{{ o.sourceName }} · {{ o.amount }}</a-tag>
            </template>
            <span v-else class="muted">—</span>
          </template>
        </a-table-column>
      </template>
    </a-table>
  </article>

  <article class="card mt16">
    <div class="panel-head"><div><h2>排队队列与占用来源</h2><p>容量不足时申请进入排队，阻塞来源逐笔列出</p></div><a-tag color="red">{{ cap.queuedEntries.length }} 排队中</a-tag></div>
    <a-table :data="cap.queuedEntries" :pagination="false" row-key="id" size="small">
      <template #columns>
        <a-table-column title="申请对象" :width="220">
          <template #cell="{ record }"><b>{{ record.sourceName }}</b><small>{{ record.sourceType === 'stage' ? '施工阶段' : '绕行路线' }} · {{ record.orderNo }}</small></template>
        </a-table-column>
        <a-table-column title="窗口" :width="170">
          <template #cell="{ record }">{{ record.windowId }}</template>
        </a-table-column>
        <a-table-column title="需占用" data-index="amount" :width="90" />
        <a-table-column title="原因" data-index="reason" :width="200" />
        <a-table-column title="占用来源（阻塞项）">
          <template #cell="{ record }">
            <a-tag v-for="(b, i) in record.blockedBy" :key="i" :color="b.type === 'emergency' ? 'red' : b.type === 'bus' ? 'orange' : 'blue'">{{ b.sourceName }} · {{ b.amount }}</a-tag>
          </template>
        </a-table-column>
      </template>
    </a-table>
  </article>
</template>

<style scoped>
.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:16px}.metric{padding:17px;border-left:4px solid #2563eb}.metric span,.metric small{display:block;color:#667085}.metric strong{display:block;font-size:29px;margin:7px 0 2px}.grid-2{display:grid;grid-template-columns:1.2fr 1fr;gap:16px}.panel-head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px}.panel-head h2{font-size:17px;margin:0 0 4px}.panel-head p{color:#7a8798;font-size:12px;margin:0}.reserve{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:11px 0;border-bottom:1px solid #edf0f5}.reserve b,.reserve small{display:block}.reserve small{color:#7a8798;margin-top:3px}.empty{color:#98a2b3;font-size:13px;padding:8px 0}.failed{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px;border:1px solid #ffe4e6;background:#fff1f2;border-radius:6px;margin-bottom:8px}.failed b,.failed small{display:block}.failed small{color:#7a8798;margin-top:3px}.log{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid #edf0f5}.log span{font-weight:700}.log small{color:#7a8798;flex:1}.log em{font-style:normal;color:#98a2b3;font-size:12px}.mt12{margin-top:12px}.mt16{margin-top:16px}.low{color:#e11d48}.muted{color:#98a2b3}
@media(max-width:1050px){.metrics{grid-template-columns:repeat(2,1fr)}.grid-2{grid-template-columns:1fr}}
</style>
