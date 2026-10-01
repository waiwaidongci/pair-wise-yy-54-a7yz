<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useSchemeStore } from '../store/scheme'
import { setWeakNetwork, weakNetworkEnabled } from '../ledger/capacityServer'
import { slotLabel } from '../ledger/engine/ledger'

const store = useSchemeStore()
const selectedDate = ref(store.dates[0] ?? '')
const deficitOnly = ref(false)
const weak = ref(weakNetworkEnabled())
const applyAmount = ref(10)
const applyMode = ref<'放行' | '排队'>('放行')
const recoverNo = ref('')

const rows = computed(() => store.ledger
  .filter((row) => row.date === selectedDate.value)
  .filter((row) => !deficitOnly.value || row.shortfall > 0)
  .sort((a, b) => a.slot - b.slot || a.linkId.localeCompare(b.linkId)))

const selectedRowKey = ref('')
const selectedRow = computed(() => rows.value.find((r) => r.key === selectedRowKey.value) ?? rows.value.find((r) => r.shortfall > 0) ?? rows.value[0])

const activeOrders = computed(() => [...store.orders].reverse())
const pendingCount = computed(() => store.pendingWrites.length)

function toggleWeak(value: boolean) { weak.value = value; setWeakNetwork(value) }

function submit() {
  const row = selectedRow.value
  if (!row || store.submitting) return
  const sourceId = row.detourDemand[0]?.id
    ?? store.orders.find((o) => o.linkId === row.linkId)?.sourceId
    ?? store.scheme.stages.find((s) => s.status !== '退回')?.id
  if (!sourceId) return
  void store.requestWindow({ date: row.date, slot: row.slot, linkId: row.linkId, amount: Number(applyAmount.value) || 0, requestedMode: applyMode.value, sourceId })
}
function recover() {
  const no = recoverNo.value.trim()
  if (no) { void store.recoverByOrderNo(no); recoverNo.value = '' }
}
function statusColor(status: string) {
  return status === '已放行' ? 'green' : status === '排队中' ? 'orange' : status === '写入未知' ? 'red' : 'gray'
}

// 选中亏空行时，默认填未覆盖亏空量并引导排队
watch(selectedRow, (row) => {
  if (!row) return
  if (row.uncoveredShortfall > 0) { applyAmount.value = row.uncoveredShortfall; applyMode.value = '排队' }
  else { applyAmount.value = Math.min(10, Math.max(1, row.available)); applyMode.value = '放行' }
})
</script>

<template>
  <section class="page-head compact">
    <div><p class="eyebrow">半小时道路容量账 · 急救/公交保底优先</p><h1>容量账与窗口占位</h1><p>每 30 分钟一行：急救通道与公交最低能力先留足，再核围挡扣减与社会绕行；容量不足只能申请排队并标明占用来源。</p></div>
    <a-space>
      <a-select :model-value="store.terminal" style="width:108px" @change="(v) => store.setTerminal(v as '终端A' | '终端B')">
        <a-option value="终端A">终端 A</a-option><a-option value="终端B">终端 B</a-option>
      </a-select>
      <a-tooltip content="开启后提交有一半概率响应丢失（服务端可能已入账），用于演练按单号恢复"><a-checkbox :model-value="weak" @change="(v) => toggleWeak(Boolean(v))">弱网故障注入</a-checkbox></a-tooltip>
      <a-popconfirm content="清空服务端全部预占单？" @ok="store.resetDemo"><a-button status="danger">重置预占</a-button></a-popconfirm>
    </a-space>
  </section>

  <a-alert v-if="store.lastMessage" class="mb16" type="info" :title="store.lastMessage" closable />

  <!-- 导出闸门：恢复/重算未完成前挡住通告 -->
  <article class="card gate" :class="store.gate.ready ? 'ok' : 'blocked'">
    <div class="gate-head"><b>通告导出闸门</b><a-tag :color="store.gate.ready ? 'green' : 'red'">{{ store.gate.ready ? '允许导出' : '导出被挡住' }}</a-tag><span class="ver">容量账版本 v{{ store.scheme.ledgerVersion }}</span></div>
    <ul v-if="!store.gate.ready">
      <li v-for="(reason, i) in store.gate.reasons" :key="i">⛔ {{ reason }}</li>
    </ul>
    <p v-else>所有窗口容量平衡、无排队/未知/旧预占、会签全部有效，可到会签页导出公开通告。</p>
  </article>

  <div class="cap-grid">
    <article class="card ledger-card">
      <div class="panel-head">
        <div><h2>半小时容量账</h2><p>保底（急救{{ store.scheme.ambulanceCorridor.minCapacity }} / 公交{{ store.scheme.busCorridor.minCapacity }} pcu）先扣，再算围挡与社会绕行</p></div>
        <a-space><a-select v-model="selectedDate" style="width:150px"><a-option v-for="d in store.dates" :key="d" :value="d">{{ d }}</a-option></a-select>
          <a-checkbox v-model="deficitOnly">只看亏空</a-checkbox>
          <a-button size="small" status="warning" :loading="store.submitting" @click="store.queueUncoveredForDate(selectedDate)">当日亏空逐窗申请排队</a-button>
        </a-space>
      </div>
      <a-table :data="rows" :pagination="{ pageSize: 12 }" :scroll="{ x: 1080 }" row-key="key"
        @row-click="(row: any) => selectedRowKey = row.key">
        <template #columns>
          <a-table-column title="窗口" :width="118" data-index="slotLabel" />
          <a-table-column title="共用路面（占用来源）" :width="250">
            <template #cell="{ record }">
              <a-tag :color="record.sharedWithCorridor ? 'arcoblue' : 'gray'" size="small">{{ record.linkId }}</a-tag>
              <small class="users">{{ record.usersText }}</small>
            </template>
          </a-table-column>
          <a-table-column title="保底预留" :width="150">
            <template #cell="{ record }">
              <span v-if="!record.reservations.length" class="muted">—</span>
              <a-tooltip v-for="r in record.reservations" :key="r.id"><span class="res" :class="r.kind === '急救保底' ? 'amb' : 'bus'">{{ r.kind.replace('保底', '') }} {{ r.amount }}</span></a-tooltip>
            </template>
          </a-table-column>
          <a-table-column title="围挡扣减" :width="120">
            <template #cell="{ record }">
              <span v-if="!record.reductions.length" class="muted">0</span>
              <a-tooltip v-for="r in record.reductions" :key="r.id"><span class="red">-{{ r.amount }}</span></a-tooltip>
            </template>
          </a-table-column>
          <a-table-column title="会签补能" :width="90">
            <template #cell="{ record }"><span v-if="!record.mitigations.length" class="muted">—</span><span v-else class="green">+{{ record.mitigations.reduce((s:number,m:any)=>s+m.amount,0) }}</span></template>
          </a-table-column>
          <a-table-column title="剩余能力" data-index="available" :width="90" />
          <a-table-column title="社会绕行申报" :width="200">
            <template #cell="{ record }">
              <span v-if="!record.applied" class="muted">0</span>
              <a-tooltip v-for="d in record.detourDemand" :key="d.id"><span class="demand">{{ d.amount }} <em>{{ d.label.split('（')[0] }}</em></span></a-tooltip>
              <span v-for="o in record.releasedOrders" :key="o.orderNo" class="order-taken">{{ o.amount }} <em>{{ o.orderNo }}</em></span>
            </template>
          </a-table-column>
          <a-table-column title="盈亏 / 排队" :width="130">
            <template #cell="{ record }">
              <a-tag :color="record.shortfall > 0 ? 'red' : 'green'">{{ record.shortfall > 0 ? `亏 ${record.shortfall}` : `余 ${record.balance}` }}</a-tag>
              <a-tag v-if="record.queued > 0" color="orange" size="small">排队 {{ record.queued }}</a-tag>
              <a-tag v-if="record.shortfall > 0 && record.uncoveredShortfall === 0" color="green" size="small">已覆盖</a-tag>
            </template>
          </a-table-column>
        </template>
      </a-table>
    </article>

    <div class="side">
      <article class="card">
        <div class="panel-head"><div><h2>窗口占位申请</h2><p>同一半小时窗口两终端同时提交，只放行一笔</p></div></div>
        <template v-if="selectedRow">
          <a-descriptions :column="1" size="small" bordered>
            <a-descriptions-item label="窗口">{{ selectedRow.date }} {{ selectedRow.slotLabel }}</a-descriptions-item>
            <a-descriptions-item label="路链">{{ selectedRow.linkId }} · {{ selectedRow.usersText }}</a-descriptions-item>
            <a-descriptions-item label="剩余能力">{{ selectedRow.available }} pcu（已扣急救/公交保底）</a-descriptions-item>
          </a-descriptions>
          <a-form layout="vertical" :model="{}" class="mt12">
            <a-form-item label="追加占用量（pcu / 30min）"><a-input-number v-model="applyAmount" :min="1" :max="120" style="width:100%" /></a-form-item>
            <a-form-item label="处理方式">
              <a-radio-group v-model="applyMode"><a-radio value="放行">容量够则放行</a-radio><a-radio value="排队">容量不足，申请排队</a-radio></a-radio-group>
            </a-form-item>
          </a-form>
          <a-alert v-if="applyMode === '放行' && applyAmount > selectedRow.available" type="warning" :title="`剩余能力仅 ${selectedRow.available}，该笔会被窗口唯一约束拒绝，请改走排队`" class="mb12" />
          <a-button type="primary" long :loading="store.submitting" @click="submit">以 {{ store.terminal }} 提交（现场单号自动生成）</a-button>
        </template>
        <a-empty v-else description="该日无容量行" />
      </article>

      <article class="card">
        <div class="panel-head"><div><h2>写入失败恢复</h2><p>按现场单号查询服务端真相，同号幂等不重复占位</p></div><a-tag v-if="pendingCount" color="red">{{ pendingCount }} 笔待恢复</a-tag></div>
        <a-input-group style="display:flex"><a-input v-model="recoverNo" placeholder="输入现场单号，如 YD20261001-001" allow-clear /><a-button type="primary" :loading="store.submitting" @click="recover">恢复</a-button></a-input-group>
        <p class="hint">响应丢失时系统只挂“写入未知”，不做第二次占位；恢复时若服务端已入账则直接认领，未入账才用原内容补提。</p>
      </article>

      <article class="card orders">
        <div class="panel-head"><div><h2>现场单号台账</h2><p>放行 / 排队 / 写入未知 / 已失效（旧账重算）</p></div></div>
        <div v-if="!activeOrders.length" class="muted center">暂无占位单</div>
        <div v-for="o in activeOrders" :key="o.orderNo" class="order" :class="o.status">
          <div class="order-top"><b>{{ o.orderNo }}</b><a-tag :color="statusColor(o.status)" size="small">{{ o.status }}</a-tag></div>
          <small>{{ o.date }} {{ slotLabel(o.slot) }} · {{ o.linkId }} · {{ o.amount }} pcu · {{ o.terminal }} · 账v{{ o.basisVersion }}</small>
          <p>{{ o.sourceLabel }}</p>
          <div class="order-actions">
            <a-button v-if="o.status === '写入未知'" size="mini" type="primary" @click="store.recoverByOrderNo(o.orderNo)">按单号恢复</a-button>
            <a-button v-if="o.status === '写入未知'" size="mini" status="danger" @click="store.discardUnknown(o.orderNo)">确认未入账后清除</a-button>
            <a-button v-if="o.status === '已失效'" size="mini" type="primary" @click="store.rebaseOrder(o.orderNo)">按新账重算</a-button>
            <a-button v-if="o.status === '排队中'" size="mini" status="danger" @click="store.cancelQueued(o.orderNo)">撤销排队</a-button>
          </div>
        </div>
      </article>
    </div>
  </div>
</template>

<style scoped>
.gate{margin-bottom:16px}.gate.blocked{border-left:4px solid #e11d48;background:#fff7f8}.gate.ok{border-left:4px solid #16a34a;background:#f6fef9}.gate-head{display:flex;align-items:center;gap:10px}.gate-head .ver{margin-left:auto;color:#7a8798;font-size:12px}.gate ul{margin:10px 0 0;padding-left:4px;list-style:none}.gate li{color:#b42318;font-size:13px;margin:4px 0}.gate p{margin:8px 0 0;color:#15803d;font-size:13px}
.cap-grid{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(340px,.8fr);gap:16px}.side{display:grid;gap:16px;align-content:start}.panel-head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px}.panel-head h2{font-size:16px;margin:0 0 4px}.panel-head p{color:#7a8798;font-size:12px;margin:0}.users{display:block;color:#7a8798;margin-top:3px;line-height:1.4}.muted{color:#98a2b3}.res{margin-right:8px;font-weight:700}.res.amb{color:#16a34a}.res.bus{color:#d97706}.red{color:#e11d48;font-weight:700}.green{color:#16a34a;font-weight:700}.demand{display:block;font-size:12px}.demand em{color:#7a8798;font-style:normal}.order-taken{display:block;font-size:12px;color:#2563eb}
.mt12{margin-top:12px}.mb12{margin-bottom:12px}.hint{font-size:12px;color:#7a8798;margin:8px 0 0;line-height:1.5}.center{text-align:center;padding:14px 0}
.orders{max-height:520px;overflow:auto}.order{border:1px solid #e7ebf1;border-radius:7px;padding:10px 11px;margin-bottom:8px}.order.写入未知{border-color:#fda4af;background:#fff7f8}.order.排队中{border-color:#fdba74;background:#fffaf0}.order.已失效{opacity:.75}.order-top{display:flex;justify-content:space-between;align-items:center}.order small{color:#7a8798;display:block;margin-top:4px}.order p{margin:6px 0 0;font-size:12px;color:#475569}.order-actions{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
@media(max-width:1100px){.cap-grid{grid-template-columns:1fr}}
</style>
