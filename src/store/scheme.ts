import { computed, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import type { CapacityOrder, ClosureStage, Scheme } from '../types'
import { buildRoadGraph } from '../ledger/engine/network'
import { buildLedger, dateRange, exportGate } from '../ledger/engine/ledger'
import {
  listOrders, queryOrder, resetAllOrders, submitOrder, subscribeOrders, nextOrderNo,
  cancelQueuedOrder, type SubmitInput,
} from '../ledger/capacityServer'

const STORAGE_KEY = 'yy54-road-scheme-v2'
const PENDING_KEY = 'yy54-capacity-pending-v1'
const TERMINAL_KEY = 'yy54-capacity-terminal'

// 节点表（0.001° 约 100m，同名坐标即同一路口）
const P0: [number, number] = [121.452, 31.224]
const P1: [number, number] = [121.462, 31.226]
const P2: [number, number] = [121.47, 31.228]
const P3: [number, number] = [121.482, 31.231]
const P4: [number, number] = [121.496, 31.235]
const P5: [number, number] = [121.508, 31.238]
const P6: [number, number] = [121.516, 31.242]
const P7: [number, number] = [121.462, 31.219]
const P8: [number, number] = [121.478, 31.214]
const P9: [number, number] = [121.502, 31.218]
// 急救中心南门、临时首末站
const A0: [number, number] = [121.476, 31.208]
const B0: [number, number] = [121.45, 31.217]

const seed: Scheme = {
  id: 'RC-2026-0918', project: '云河路快速化改造', contractor: '市政建设集团第三工程处', area: '云河路 / 江海大道', version: 7, ledgerVersion: 1,
  stages: [
    {
      id: 'ST-01', name: '第一阶段 · 东半幅围挡', start: '2026-10-08', end: '2026-10-22', lanes: '双向 4 车道收窄为 2 车道', status: '条件通过', route: [P2, P3, P4],
      demand: {
        detourId: 'DR-02', base: 34,
        windows: [{ startSlot: 12, endSlot: 42 }],
        peakFactor: { 16: 1.35, 17: 1.35, 35: 1.3 },
        // 交通组信号配时条件接受后，辅道三口每半小时补 12 pcu
        mitigation: { basisCommentId: 'CM-44', extraCapacity: 12 },
      },
      closure: { reduction: 18, mitigatedReduction: 18, windows: [{ startSlot: 0, endSlot: 47 }] },
    },
    {
      id: 'ST-02', name: '第二阶段 · 路口夜间施工', start: '2026-10-23', end: '2026-11-05', lanes: '22:00–05:00 全封闭', status: '待协商', route: [P9, P5, P6],
      demand: { detourId: 'DR-01', base: 50, windows: [{ startSlot: 44, endSlot: 47 }, { startSlot: 0, endSlot: 9 }] },
      // 应急条件（保留 4 米通道）接受后，围挡扣减从 45 降到 30
      closure: { reduction: 45, mitigatedReduction: 30, windows: [{ startSlot: 44, endSlot: 47 }, { startSlot: 0, endSlot: 9 }], basisCommentId: 'CM-42' },
    },
    {
      id: 'ST-03', name: '第三阶段 · 西半幅恢复', start: '2026-11-06', end: '2026-11-18', lanes: '西侧公交专用道临时占用', status: '退回', route: [P0, P1, P2],
      demand: { detourId: 'DR-02', base: 20, windows: [{ startSlot: 12, endSlot: 42 }] },
      closure: { reduction: 10, mitigatedReduction: 10, windows: [{ startSlot: 0, endSlot: 47 }] },
    },
  ],
  detours: [
    { id: 'DR-01', name: '江海大道—滨河路绕行', distance: 4.8, extraMinutes: 11, coordinates: [P2, P8, P9, P5, P6] },
    { id: 'DR-02', name: '云河路辅道保通', distance: 2.3, extraMinutes: 6, coordinates: [P0, P7, P9, P4] },
  ],
  ambulanceCorridor: {
    id: 'AM-01', name: '急救中心南门前置通道', kind: '急救', minCapacity: 30,
    service: [{ startSlot: 0, endSlot: 47 }],
    coordinates: [A0, P8, P9, P4, P9, P5],
  },
  busCorridor: {
    id: 'BS-01', name: '17路/806路公交通廊', kind: '公交', minCapacity: 20,
    service: [{ startSlot: 10, endSlot: 43 }],
    coordinates: [B0, P7, P9, P4, P5],
  },
  adjacentWorks: [
    {
      id: 'AJ-01', name: '相邻雨污分流工程', start: '2026-10-26', end: '2026-10-30',
      windows: [{ startSlot: 44, endSlot: 47 }, { startSlot: 0, endSlot: 9 }], reduction: 15,
      occupyCoordinates: [P9, P5],
    },
  ],
  comments: [
    { id: 'CM-41', segmentId: 'ST-01', unit: '公交', author: '顾敏', content: '17 路、806 路临时站点与云河路站距离 680 米，超过老年乘客可接受步行距离。', condition: '需在江海大道口增设临时站并配置导乘人员。', status: '待处理' },
    { id: 'CM-42', segmentId: 'ST-02', unit: '应急', author: '夏川', content: '夜间全封闭期间，区域急救中心南门通道被切断，绕行通道与社会车辆共线 1.2 公里。', condition: '保留 4 米应急通道，路口导改每 15 分钟巡查一次；围挡相应内收。', status: '待处理' },
    { id: 'CM-43', segmentId: 'ST-03', unit: '交通', author: '郑航', content: '公交专用道占用导致高峰小时延误增加 19 分钟，超过方案阈值。', condition: '缩减围挡 1.5 米并调整信号配时。', status: '已退回' },
    { id: 'CM-44', segmentId: 'ST-01', unit: '交通', author: '郑航', content: '辅道三口（P9–P4）早晚高峰社会绕行与公交、急救共用路面，容量接近下限。', condition: '高峰时段启用信号配时优化，辅道三口每半小时补充 12 pcu 放行能力。', status: '待处理' },
  ],
}

interface PendingWrite { input: SubmitInput; savedAt: number }

function loadScheme(): Scheme {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Scheme
      if (parsed.ledgerVersion && parsed.ambulanceCorridor) return parsed
    }
  } catch { /* ignore */ }
  return structuredClone(seed)
}

function loadPending(): PendingWrite[] {
  try { return JSON.parse(localStorage.getItem(PENDING_KEY) ?? '[]') as PendingWrite[] } catch { return [] }
}
function savePending(list: PendingWrite[]) { localStorage.setItem(PENDING_KEY, JSON.stringify(list)) }

export function currentTerminal(): '终端A' | '终端B' {
  let value = localStorage.getItem(TERMINAL_KEY) as '终端A' | '终端B' | null
  if (!value) {
    // 同一浏览器演示：标签页用终端 A；用户可切换。真实环境按工位固化
    value = '终端A'
    localStorage.setItem(TERMINAL_KEY, value)
  }
  return value
}

export const useSchemeStore = defineStore('scheme', () => {
  const scheme = ref<Scheme>(loadScheme())
  const selectedStageId = ref('ST-01')
  const selectedCommentId = ref('CM-41')
  const drawing = ref(false)
  const draftRoute = ref<[number, number][]>([])
  const history = ref<string[]>([])
  const terminal = ref<'终端A' | '终端B'>(currentTerminal())
  const orders = shallowRef<CapacityOrder[]>(listOrders())
  const pendingWrites = ref<PendingWrite[]>(loadPending())
  const submitting = ref(false)
  const lastMessage = ref('')

  const links = computed(() => buildRoadGraph(scheme.value))
  const linkById = computed(() => new Map(links.value.map((link) => [link.id, link])))
  const ledger = computed(() => buildLedger(scheme.value, links.value, orders.value))
  const gate = computed(() => exportGate(scheme.value, ledger.value, orders.value))
  const dates = computed(() => dateRange(scheme.value))
  const selectedStage = computed(() => scheme.value.stages.find((item) => item.id === selectedStageId.value))
  const selectedComment = computed(() => scheme.value.comments.find((item) => item.id === selectedCommentId.value))
  const dirty = computed(() => history.value.length > 0)

  function linkLabel(linkId: string) {
    const link = linkById.value.get(linkId)
    return link ? link.users.map((u) => u.label).join(' / ') : linkId
  }

  // 容量账冲突直接驱动总览/地图的检测结果
  const conflicts = computed(() => {
    const out: { id: string; level: '高' | '中'; segmentId: string; title: string; detail: string }[] = []
    if (scheme.value.stages.some((stage) => stage.id === 'ST-02' && stage.status !== '退回' && scheme.value.adjacentWorks.some((w) => w.start <= '2026-10-30'))) {
      out.push({ id: 'CF-01', level: '高', segmentId: 'ST-02', title: '相邻雨污分流工程时间重叠', detail: '10 月 26–30 日江海大道东段同步占用慢车道，夜间窗口共线路段（P9–P5）叠加扣减 15 pcu。' })
    }
    const deficitRows = ledger.value.filter((row) => row.shortfall > 0)
    deficitRows.slice(0, 4).forEach((row, index) => {
      const source = row.detourDemand[0]
      const stage = scheme.value.stages.find((s) => s.id === source?.id)
      const corridorHit = row.reservations.map((r) => r.kind === '急救保底' ? '急救' : '公交').join('、')
      out.push({
        id: `CF-L${index + 1}`,
        level: row.reservations.some((r) => r.kind === '急救保底') ? '高' : '中',
        segmentId: stage?.id ?? 'ST-01',
        title: `${corridorHit}共线路面半小时容量亏空 ${row.shortfall} pcu`,
        detail: `${row.date} ${row.slotLabel}，${linkLabel(row.linkId)}（${row.linkId}）：剩余能力 ${row.available}，社会绕行申报 ${row.applied}。占用来源：${[...row.detourDemand, ...row.releasedOrders.map((o) => ({ id: o.orderNo, label: o.sourceLabel }))].map((d) => d.label).join('、') || '—'}`,
      })
    })
    if (orders.value.some((o) => o.status === '写入未知')) out.push({ id: 'CF-UNKNOWN', level: '高', segmentId: orders.value.find((o) => o.status === '写入未知')?.sourceId ?? 'ST-01', title: '存在写入结果不明的现场单号', detail: '弱网下写入可能已入账，必须按现场单号查询恢复，禁止重复占位。' })
    return out
  })

  function persist() { localStorage.setItem(STORAGE_KEY, JSON.stringify(scheme.value)) }
  function commit() { history.value.push(JSON.stringify(scheme.value)); persist() }

  function setTerminal(value: '终端A' | '终端B') { terminal.value = value; localStorage.setItem(TERMINAL_KEY, value) }

  /** 服务端订单 + 本地“写入未知”单合并；本地未知单在恢复出结果前不能被服务端刷新冲掉 */
  function mergeOrders(server: CapacityOrder[]): CapacityOrder[] {
    const serverSet = new Set(server.map((o) => o.orderNo))
    const localUnknown = orders.value.filter((o) => o.status === '写入未知' && !serverSet.has(o.orderNo))
    return [...server, ...localUnknown].sort((a, b) => a.createdAt - b.createdAt)
  }
  function refreshOrders() { orders.value = mergeOrders(listOrders()) }

  // —— 阶段时间/路线/车道、绕行任一变化：账版本递增，旧预占与锚定会签失效重算 ——
  function bumpLedger(reason: string) {
    scheme.value.ledgerVersion += 1
    const server = listOrders().map((order) => {
      if ((order.status === '已放行' || order.status === '排队中') && order.basisVersion !== scheme.value.ledgerVersion) {
        return { ...order, status: '已失效' as const }
      }
      return order
    })
    // 同步服务端失效态（只放宽、不产生占用）
    const raw = localStorage.getItem('yy54-capacity-orders-v1')
    if (raw) {
      const state = JSON.parse(raw)
      state.orders = server
      localStorage.setItem('yy54-capacity-orders-v1', JSON.stringify(state))
    }
    scheme.value.comments.forEach((comment) => {
      if (comment.segmentId === reason && comment.status !== '已退回') comment.status = '失效待重签'
    })
    persist()
    orders.value = mergeOrders(server)
  }

  function finishDraw() {
    if (draftRoute.value.length >= 2 && selectedStage.value) {
      const stage = selectedStage.value
      commit()
      stage.route = [...draftRoute.value]
      stage.status = '待协商'
      scheme.value.version += 1
      bumpLedger(stage.id)
    }
    drawing.value = false
    draftRoute.value = []
  }
  function startDraw() { drawing.value = true; draftRoute.value = [] }
  function addPoint(point: [number, number]) { if (drawing.value) draftRoute.value.push(point) }

  function updateStage(patch: Partial<ClosureStage>) {
    const stage = selectedStage.value
    if (!stage) return
    const affectsLedger = Object.keys(patch).some((key) => ['start', 'end', 'lanes', 'route', 'status'].includes(key))
    commit()
    Object.assign(stage, patch)
    if (affectsLedger) { stage.status = patch.status ?? (stage.status === '已批准' ? stage.status : '待协商'); scheme.value.version += 1; bumpLedger(stage.id) }
    persist()
  }

  function resolveComment(id: string, status: '已接受' | '已退回' | '待处理') {
    const comment = scheme.value.comments.find((item) => item.id === id)
    if (!comment) return
    commit()
    comment.status = status
    scheme.value.version += 1
    persist()
  }
  function reSignComment(id: string) { resolveComment(id, '待处理') }

  function undo() {
    const previous = history.value.pop()
    if (previous) { scheme.value = JSON.parse(previous); persist(); refreshOrders() }
  }

  // —— 半小时窗口占位申请 ——
  function findRow(date: string, slot: number, linkId: string) {
    return ledger.value.find((r) => r.date === date && r.slot === slot && r.linkId === linkId)
  }

  async function requestWindow(args: { date: string; slot: number; linkId: string; amount: number; requestedMode: '放行' | '排队'; sourceId: string }) {
    const link = linkById.value.get(args.linkId)
    const stage = scheme.value.stages.find((s) => s.id === args.sourceId)
    if (!link || !stage || submitting.value) return
    const row = findRow(args.date, args.slot, args.linkId)
    // 容量账闸门：放行量不得占用急救/公交保底后仍超出剩余能力
    if (args.requestedMode === '放行' && row && args.amount > row.available) {
      lastMessage.value = `剩余能力仅 ${row.available} pcu（已先留急救/公交保底），不能放行 ${args.amount}；请改申请排队`
      return
    }
    const windowKey = `${args.date}|${args.slot}|${args.linkId}`
    const input: SubmitInput = {
      orderNo: nextOrderNo(),
      windowKey, date: args.date, slot: args.slot, linkId: args.linkId, amount: args.amount,
      terminal: terminal.value, requestedMode: args.requestedMode, sourceId: args.sourceId,
      sourceLabel: `${stage.name.replace(/ · .*$/, '')}追加预占（${link.users.map((u) => u.label).join('/')}）`,
      basisVersion: scheme.value.ledgerVersion,
    }
    submitting.value = true
    const result = await submitOrder(input)
    if (result.ok) {
      lastMessage.value = `现场单号 ${input.orderNo} 已${result.order?.status === '已放行' ? '放行入账' : '进入排队'}`
      pendingWrites.value = pendingWrites.value.filter((item) => item.input.orderNo !== input.orderNo)
    } else if (result.code === 'TRANSPORT_LOST') {
      // 写入失败：本地只登记“写入未知”并保存现场单号，不做第二次占位
      const unknown: CapacityOrder = {
        ...input, mode: input.requestedMode, status: '写入未知', createdAt: Date.now(),
        note: '写入结果不明，可能服务端已入账；请按单号恢复，切勿重复提交',
      }
      const local = [...orders.value]
      const index = local.findIndex((o) => o.orderNo === unknown.orderNo)
      if (index >= 0) local[index] = unknown; else local.push(unknown)
      orders.value = local
      if (!pendingWrites.value.some((item) => item.input.orderNo === input.orderNo)) {
        pendingWrites.value = [...pendingWrites.value, { input, savedAt: Date.now() }]
        savePending(pendingWrites.value)
      }
      lastMessage.value = `现场单号 ${input.orderNo} 写入失败，已挂为“写入未知”，请按单号恢复`
    } else if (result.code === 'WINDOW_TAKEN') {
      lastMessage.value = `该窗口已由 ${result.heldBy?.terminal} 的现场单号 ${result.heldBy?.orderNo} 放行，本终端申请被拒`
    } else {
      lastMessage.value = '另一终端正在提交同一窗口，互斥未抢到，未占位'
    }
    refreshOrders()
    savePending(pendingWrites.value)
    submitting.value = false
  }

  /** 把某日全部“未覆盖亏空”逐窗申请排队，每笔标明占用来源（社会绕行阶段） */
  async function queueUncoveredForDate(date: string) {
    const targets = ledger.value.filter((r) => r.date === date && r.uncoveredShortfall > 0)
    if (!targets.length || submitting.value) return
    let queued = 0
    for (const row of targets) {
      const sourceId = row.detourDemand[0]?.id
        ?? orders.value.find((o) => o.linkId === row.linkId)?.sourceId
        ?? scheme.value.stages.find((s) => s.status !== '退回')?.id
      if (!sourceId) continue
      // 逐窗调用（服务端逐窗记账、逐号幂等）；排队不触发窗口唯一放行约束。await 串行保证不抢自己的锁
      // eslint-disable-next-line no-await-in-loop
      await requestWindow({ date: row.date, slot: row.slot, linkId: row.linkId, amount: row.uncoveredShortfall, requestedMode: '排队', sourceId })
      const now = findRow(row.date, row.slot, row.linkId)
      if (now && now.queuedOrders.some((o) => o.sourceId === sourceId)) queued += 1
    }
    if (queued) lastMessage.value = `${date} 的 ${queued} 个亏空窗口已逐窗申请排队，占用来源已登记`
  }

  /** 写入失败后按现场单号恢复：只查服务端真相，同号幂等，绝不重复占位 */
  async function recoverByOrderNo(orderNo: string) {
    const local = orders.value.find((o) => o.orderNo === orderNo)
    const pending = pendingWrites.value.find((item) => item.input.orderNo === orderNo)
    // 先查：服务端若已入账，直接以服务端记录为准
    let server = queryOrder(orderNo)
    if (!server && pending) {
      // 服务端没有 → 说明当时根本没写成功；用原单号原内容幂等补提一次
      submitting.value = true
      const result = await submitOrder(pending.input)
      submitting.value = false
      if (result.ok && result.order) server = result.order
      else { lastMessage.value = '恢复失败：窗口可能已被占用或网络仍异常'; refreshOrders(); return }
    }
    if (server) {
      const next = [...orders.value.filter((o) => o.orderNo !== orderNo), server]
      orders.value = next
      pendingWrites.value = pendingWrites.value.filter((item) => item.input.orderNo !== orderNo)
      savePending(pendingWrites.value)
      lastMessage.value = `单号 ${orderNo} 已恢复：服务端状态「${server.status}」，未产生重复占位`
    } else if (local?.status === '写入未知') {
      lastMessage.value = `单号 ${orderNo} 在服务端查无记录，且本地无原始申请，需现场重新申请新单号`
    }
    refreshOrders()
  }

  /** 服务端确认查无记录后，丢弃本地未知单（从未入账，可安全改新单号重报） */
  function discardUnknown(orderNo: string) {
    orders.value = orders.value.filter((o) => o.orderNo !== orderNo)
    pendingWrites.value = pendingWrites.value.filter((item) => item.input.orderNo !== orderNo)
    savePending(pendingWrites.value)
    lastMessage.value = `单号 ${orderNo} 经服务端确认从未入账，本地挂账已清除，可用新单号重报`
  }

  /** 旧账版本预占：按原单号在新账上重算（放行需窗口仍唯一、容量仍够） */
  async function rebaseOrder(orderNo: string) {
    const order = orders.value.find((o) => o.orderNo === orderNo)
    if (!order) return
    const row = ledger.value.find((r) => r.date === order.date && r.slot === order.slot && r.linkId === order.linkId)
    submitting.value = true
    const requestMode: '放行' | '排队' = row && row.available >= order.amount && order.mode === '放行' ? '放行' : '排队'
    const result = await submitOrder({
      orderNo, windowKey: order.windowKey, date: order.date, slot: order.slot, linkId: order.linkId,
      amount: order.amount, terminal: order.terminal, requestedMode: requestMode,
      sourceId: order.sourceId, sourceLabel: order.sourceLabel, basisVersion: scheme.value.ledgerVersion,
    })
    submitting.value = false
    if (result.ok && result.order) {
      orders.value = [...orders.value.filter((o) => o.orderNo !== orderNo), result.order]
      lastMessage.value = `单号 ${orderNo} 已按新账重算：${result.order.status}`
    } else if (result.code === 'WINDOW_TAKEN') {
      lastMessage.value = `单号 ${orderNo} 重算失败：窗口已被 ${result.heldBy?.orderNo} 占用`
    } else {
      lastMessage.value = `单号 ${orderNo} 重算失败：${result.code ?? '窗口繁忙'}`
    }
    refreshOrders()
  }

  function cancelQueued(orderNo: string) {
    cancelQueuedOrder(orderNo)
    refreshOrders()
    lastMessage.value = `排队单号 ${orderNo} 已撤销`
  }

  function resetDemo() {
    resetAllOrders()
    localStorage.removeItem(PENDING_KEY)
    pendingWrites.value = []
    orders.value = []
    lastMessage.value = '服务端预占已清空（演示重置）'
  }

  const unsubscribe = subscribeOrders(() => refreshOrders())
  void unsubscribe

  return {
    scheme, selectedStageId, selectedCommentId, selectedStage, selectedComment,
    drawing, draftRoute, links, linkById, ledger, gate, dates, conflicts, dirty,
    terminal, orders, pendingWrites, submitting, lastMessage,
    linkLabel, setTerminal, startDraw, addPoint, finishDraw, updateStage,
    resolveComment, reSignComment, undo, requestWindow, queueUncoveredForDate, recoverByOrderNo, discardUnknown, rebaseOrder, cancelQueued, resetDemo,
  }
})
