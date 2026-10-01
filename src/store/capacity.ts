import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { useSchemeStore } from './scheme'
import type {
  CapacityWindow, Occupation, QueueEntry, FailedOrder, SubmitResult,
  RecoveryState, OccupationSourceType, CapacityRoadId,
} from '../types'

const WINDOWS_KEY = 'yy54-capacity-windows-v1'
const OCC_KEY = 'yy54-capacity-occupations-v1'
const QUEUE_KEY = 'yy54-capacity-queue-v1'
const FAILED_KEY = 'yy54-capacity-failed-v1'
const LOCK_KEY = 'yy54-capacity-locks-v1'
const BC_CHANNEL = 'road-capacity-ledger'
const LOCK_TTL = 8000

const PLAN_START = '2026-10-08'
const PLAN_END = '2026-11-18'

const ROADS: { id: CapacityRoadId; name: string; total: number; emergency: number; bus: number }[] = [
  { id: 'main', name: '云河路（施工段）', total: 1000, emergency: 150, bus: 200 },
  { id: 'dr-01', name: '江海大道—滨河路绕行', total: 800, emergency: 0, bus: 120 },
  { id: 'dr-02', name: '云河路辅道保通', total: 600, emergency: 0, bus: 100 },
]

function load<T>(key: string, fallback: () => T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback()
  } catch {
    return fallback()
  }
}

function genWindows(): CapacityWindow[] {
  const windows: CapacityWindow[] = []
  const cursor = new Date(`${PLAN_START}T00:00:00`)
  const end = new Date(`${PLAN_END}T23:59:59`)
  while (cursor <= end) {
    const date = cursor.toISOString().slice(0, 10)
    for (let h = 0; h < 24; h++) {
      for (const m of [0, 30]) {
        const start = `${String(h).padStart(2, '0')}:${m === 0 ? '00' : '30'}`
        const endH = m === 0 ? h : h + 1
        const endMin = m === 0 ? 30 : 0
        const end = `${String(endH % 24).padStart(2, '0')}:${endMin === 30 ? '30' : '00'}`
        for (const road of ROADS) {
          windows.push({
            windowId: `${date}T${start}/${end}#${road.id}`,
            date, start, end,
            roadId: road.id, roadName: road.name,
            total: road.total,
            reservedEmergency: road.emergency,
            reservedBus: road.bus,
            version: 1,
          })
        }
      }
    }
    cursor.setDate(cursor.getDate() + 1)
  }
  return windows
}

function stageAmount(stage: { lanes: string }): number {
  if (stage.lanes.includes('全封闭')) return 720
  if (stage.lanes.includes('占用')) return 260
  return 360
}
function stageBand(stage: { lanes: string }): 'day' | 'night' {
  return stage.lanes.includes('夜间') || stage.lanes.includes('22:00') ? 'night' : 'day'
}
function inBand(startMin: number, band: 'day' | 'night'): boolean {
  if (band === 'night') return startMin >= 22 * 60 || startMin < 5 * 60
  return startMin >= 6 * 60 && startMin < 22 * 60
}
function detourAmount(detour: { distance: number }): number {
  return detour.distance > 4 ? 320 : 240
}

function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

export const useCapacityStore = defineStore('capacity', () => {
  const schemeStore = useSchemeStore()
  const windows = ref<CapacityWindow[]>(load(WINDOWS_KEY, genWindows))
  const occupations = ref<Occupation[]>(load(OCC_KEY, () => []))
  const queue = ref<QueueEntry[]>(load(QUEUE_KEY, () => []))
  const failedOrders = ref<FailedOrder[]>(load(FAILED_KEY, () => []))
  const recoveryState = ref<RecoveryState>('idle')
  const lastResults = ref<SubmitResult[]>([])
  const terminalLog = ref<{ terminal: string; orderNo: string; outcome: string; windowId: string; at: number }[]>([])
  const simulateWriteFail = ref(false)

  let bc: BroadcastChannel | null = null
  if (typeof BroadcastChannel !== 'undefined') {
    bc = new BroadcastChannel(BC_CHANNEL)
    bc.onmessage = (event) => {
      if (event.data?.type === 'state-changed') reload()
    }
  }

  function reload() {
    windows.value = load(WINDOWS_KEY, genWindows)
    occupations.value = load(OCC_KEY, () => [])
    queue.value = load(QUEUE_KEY, () => [])
    failedOrders.value = load(FAILED_KEY, () => [])
  }
  function persist() {
    localStorage.setItem(WINDOWS_KEY, JSON.stringify(windows.value))
    localStorage.setItem(OCC_KEY, JSON.stringify(occupations.value))
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.value))
    localStorage.setItem(FAILED_KEY, JSON.stringify(failedOrders.value))
    bc?.postMessage({ type: 'state-changed' })
  }

  const windowsById = computed(() => new Map(windows.value.map((w) => [w.windowId, w])))
  const validOccupations = computed(() => occupations.value.filter((o) => o.status === 'reserved'))
  const queuedEntries = computed(() => queue.value.filter((q) => q.status === 'waiting'))
  const exportBlocked = computed(() => recoveryState.value === 'recalculating')

  function occupiedAmount(windowId: string): number {
    return validOccupations.value
      .filter((o) => o.windowId === windowId)
      .reduce((sum, o) => sum + o.amount, 0)
  }
  function availableOf(win: CapacityWindow): number {
    return win.total - win.reservedEmergency - win.reservedBus - occupiedAmount(win.windowId)
  }
  function windowStatus(win: CapacityWindow): '充足' | '紧张' | '排队' {
    if (queuedEntries.value.some((q) => q.windowId === win.windowId)) return '排队'
    if (availableOf(win) < win.total * 0.15) return '紧张'
    return '充足'
  }
  function windowOccupations(windowId: string): Occupation[] {
    return validOccupations.value.filter((o) => o.windowId === windowId)
  }

  // 窗口锁：两个终端同时提交同一窗口只放行一笔
  function acquireLock(windowId: string, orderNo: string, terminal: string): boolean {
    const locks = JSON.parse(localStorage.getItem(LOCK_KEY) || '{}') as Record<string, { orderNo: string; terminal: string; at: number }>
    const now = Date.now()
    const existing = locks[windowId]
    if (existing && existing.orderNo !== orderNo && existing.at + LOCK_TTL > now) return false
    locks[windowId] = { orderNo, terminal, at: now }
    localStorage.setItem(LOCK_KEY, JSON.stringify(locks))
    return true
  }
  function releaseLock(windowId: string, orderNo: string) {
    const locks = JSON.parse(localStorage.getItem(LOCK_KEY) || '{}') as Record<string, { orderNo: string; terminal: string; at: number }>
    if (locks[windowId]?.orderNo === orderNo) {
      delete locks[windowId]
      localStorage.setItem(LOCK_KEY, JSON.stringify(locks))
    }
  }
  function lockHolder(windowId: string): string | null {
    const locks = JSON.parse(localStorage.getItem(LOCK_KEY) || '{}') as Record<string, { orderNo: string; terminal: string; at: number }>
    const existing = locks[windowId]
    if (existing && existing.at + LOCK_TTL > Date.now()) return existing.terminal
    return null
  }

  // 单窗口提交：幂等 + 窗口锁 + 容量校验
  function submitWindow(
    windowId: string,
    orderNo: string,
    amount: number,
    source: { type: OccupationSourceType; id: string; name: string },
    terminal: string,
  ): SubmitResult {
    const duplicate = validOccupations.value.find((o) => o.orderNo === orderNo && o.windowId === windowId)
    if (duplicate) return { outcome: 'duplicate', windowId, orderNo, amount, occupation: duplicate }

    const win = windowsById.value.get(windowId)
    if (!win) return { outcome: 'conflict', windowId, orderNo, amount, heldBy: '系统', holderSource: '窗口不存在' }

    if (!acquireLock(windowId, orderNo, terminal)) {
      return { outcome: 'conflict', windowId, orderNo, amount, heldBy: lockHolder(windowId) ?? '其他终端', holderSource: '窗口锁占用中' }
    }
    try {
      const occupied = occupiedAmount(windowId)
      const available = win.total - win.reservedEmergency - win.reservedBus - occupied
      if (available >= amount) {
        const occ: Occupation = {
          id: genId('YZ'), orderNo, windowId, roadId: win.roadId,
          sourceType: source.type, sourceId: source.id, sourceName: source.name,
          amount, status: 'reserved', linkedCommentIds: [], createdAt: Date.now(),
        }
        occupations.value.push(occ)
        win.version += 1
        persist()
        return { outcome: 'admitted', windowId, orderNo, amount, occupation: occ }
      }
      const blockedBy: QueueEntry['blockedBy'] = []
      if (win.reservedEmergency > 0) blockedBy.push({ sourceName: '急救通道预留（先留足）', amount: win.reservedEmergency, type: 'emergency' })
      if (win.reservedBus > 0) blockedBy.push({ sourceName: '公交最低能力预留（先留足）', amount: win.reservedBus, type: 'bus' })
      for (const o of windowOccupations(windowId)) blockedBy.push({ sourceName: o.sourceName, amount: o.amount, type: o.sourceType })
      const q: QueueEntry = {
        id: genId('PD'), orderNo, windowId, roadId: win.roadId,
        sourceType: source.type, sourceId: source.id, sourceName: source.name,
        amount, reason: `容量不足：可用 ${available} < 需 ${amount}`,
        blockedBy, status: 'waiting', requestedAt: Date.now(),
      }
      queue.value.push(q)
      persist()
      return { outcome: 'queued', windowId, orderNo, amount, queueEntry: q }
    } finally {
      releaseLock(windowId, orderNo)
    }
  }

  function eachWindowInRange(start: string, end: string, roadId: CapacityRoadId, cb: (win: CapacityWindow) => void) {
    const cursor = new Date(`${start}T00:00:00`)
    const endDate = new Date(`${end}T23:59:59`)
    while (cursor <= endDate) {
      const date = cursor.toISOString().slice(0, 10)
      for (const win of windows.value) {
        if (win.roadId !== roadId || win.date !== date) continue
        cb(win)
      }
      cursor.setDate(cursor.getDate() + 1)
    }
  }

  function reserveStage(stageId: string, orderNo?: string): SubmitResult[] {
    const stage = schemeStore.scheme.stages.find((s) => s.id === stageId)
    if (!stage) return []
    const no = orderNo ?? `STAGE-${stageId}`
    const band = stageBand(stage)
    const amount = stageAmount(stage)
    const results: SubmitResult[] = []
    eachWindowInRange(stage.start, stage.end, 'main', (win) => {
      const [h, m] = win.start.split(':').map(Number)
      if (!inBand(h * 60 + m, band)) return
      results.push(submitWindow(win.windowId, no, amount, { type: 'stage', id: stageId, name: stage.name }, '终端 A'))
    })
    const commentIds = schemeStore.scheme.comments.filter((c) => c.segmentId === stageId).map((c) => c.id)
    validOccupations.value.filter((o) => o.orderNo === no).forEach((o) => { o.linkedCommentIds = commentIds })
    lastResults.value = results
    persist()
    return results
  }

  function reserveDetour(detourId: string, orderNo?: string): SubmitResult[] {
    const detour = schemeStore.scheme.detours.find((d) => d.id === detourId)
    if (!detour) return []
    const no = orderNo ?? `DETOUR-${detourId}`
    const amount = detourAmount(detour)
    const roadId = detourId.toLowerCase() as CapacityRoadId
    const results: SubmitResult[] = []
    eachWindowInRange(PLAN_START, PLAN_END, roadId, (win) => {
      const [h] = win.start.split(':').map(Number)
      if (h < 6 || h >= 22) return
      results.push(submitWindow(win.windowId, no, amount, { type: 'detour', id: detourId, name: detour.name }, '终端 A'))
    })
    lastResults.value = results
    persist()
    return results
  }

  // 发起预占（带现场单号；可模拟写入失败）
  function submitReservation(objectType: OccupationSourceType, objectId: string): { orderNo: string; failed: boolean; results: SubmitResult[] } {
    const orderNo = genId('XCD')
    if (simulateWriteFail.value) {
      const objName = objectType === 'stage'
        ? schemeStore.scheme.stages.find((s) => s.id === objectId)?.name
        : schemeStore.scheme.detours.find((d) => d.id === objectId)?.name
      failedOrders.value.push({ orderNo, objectType, objectId, objectName: objName ?? objectId, at: Date.now() })
      persist()
      return { orderNo, failed: true, results: [] }
    }
    const results = objectType === 'stage' ? reserveStage(objectId, orderNo) : reserveDetour(objectId, orderNo)
    return { orderNo, failed: false, results }
  }

  // 写入失败后按现场单号恢复，不能重复占位
  function recoverByOrderNo(orderNo: string): { status: string; results?: SubmitResult[] } {
    // 幂等优先：只要该单号已有有效预占，原样返回，不重复占位
    const existing = validOccupations.value.filter((o) => o.orderNo === orderNo)
    if (existing.length) {
      return {
        status: 'recovered-existing',
        results: existing.map((o) => ({ outcome: 'duplicate' as const, windowId: o.windowId, orderNo, amount: o.amount, occupation: o })),
      }
    }
    const failed = failedOrders.value.find((f) => f.orderNo === orderNo)
    if (!failed) return { status: 'not-found' }
    const results = failed.objectType === 'stage' ? reserveStage(failed.objectId, orderNo) : reserveDetour(failed.objectId, orderNo)
    failedOrders.value = failedOrders.value.filter((f) => f.orderNo !== orderNo)
    persist()
    return { status: 'recovered-created', results }
  }

  // 阶段时间或路线一变：旧预占和对应会签失效，重算（异步，期间挡住导出）
  function invalidateStage(stageId: string): Promise<{ results: SubmitResult[]; allAdmitted: boolean }> {
    occupations.value.forEach((o) => { if (o.sourceType === 'stage' && o.sourceId === stageId) o.status = 'invalid' })
    schemeStore.scheme.comments.forEach((c) => { if (c.segmentId === stageId) c.invalid = true })
    recoveryState.value = 'recalculating'
    persist()
    return new Promise((resolve) => {
      setTimeout(() => {
        const results = reserveStage(stageId)
        schemeStore.scheme.comments.forEach((c) => { if (c.segmentId === stageId) c.invalid = false })
        recoveryState.value = 'recovered'
        persist()
        resolve({ results, allAdmitted: results.every((r) => r.outcome === 'admitted' || r.outcome === 'duplicate') })
      }, 900)
    })
  }

  function recalculateAll(): Promise<void> {
    recoveryState.value = 'recalculating'
    schemeStore.scheme.stages.forEach((s) => {
      occupations.value.forEach((o) => { if (o.sourceType === 'stage' && o.sourceId === s.id) o.status = 'invalid' })
    })
    persist()
    return new Promise((resolve) => {
      setTimeout(() => {
        schemeStore.scheme.stages.forEach((s) => reserveStage(s.id))
        recoveryState.value = 'recovered'
        persist()
        resolve()
      }, 900)
    })
  }

  // 两个终端同时提交同一窗口：只放行一笔
  function demoConcurrent(windowId: string) {
    const orderA = genId('XCD-A')
    const orderB = genId('XCD-B')
    const sourceA = { type: 'stage' as const, id: 'ST-01', name: '第一阶段 · 东半幅围挡' }
    const sourceB = { type: 'detour' as const, id: 'DR-01', name: '江海大道—滨河路绕行' }
    // 终端 A 在途（持锁），终端 B 同时提交
    acquireLock(windowId, orderA, '终端 A')
    const rB = submitWindow(windowId, orderB, 200, sourceB, '终端 B')
    terminalLog.value.push({ terminal: '终端 B', orderNo: orderB, outcome: rB.outcome, windowId, at: Date.now() })
    // 终端 A 随后完成
    setTimeout(() => {
      const rA = submitWindow(windowId, orderA, 200, sourceA, '终端 A')
      releaseLock(windowId, orderA)
      terminalLog.value.push({ terminal: '终端 A', orderNo: orderA, outcome: rA.outcome, windowId, at: Date.now() })
      persist()
    }, 400)
    persist()
    return { orderA, orderB, rB }
  }

  function clearTerminalLog() { terminalLog.value = [] }

  return {
    windows, occupations, queue, failedOrders, recoveryState, lastResults, terminalLog, simulateWriteFail,
    validOccupations, queuedEntries, windowsById, exportBlocked,
    occupiedAmount, availableOf, windowStatus, windowOccupations,
    submitWindow, reserveStage, reserveDetour, submitReservation, recoverByOrderNo,
    invalidateStage, recalculateAll, demoConcurrent, clearTerminalLog, persist,
  }
})
