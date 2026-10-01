import type { CapacityOrder, OrderStatus } from '../types'

/**
 * 模拟共享后端：两个浏览器标签页即两个作业终端。
 * - localStorage 是跨标签页的共享存储，storage 事件做实时同步
 * - 提交先抢跨终端互斥锁，落库时再对「同一半小时窗口只放一笔」做唯一约束（双保险）
 * - 现场单号全局幂等：同号重提绝不产生第二条占用
 * - 弱网开关下写入结果不明（可能已入账、可能未入账），只能凭单号查询恢复
 */

const ORDERS_KEY = 'yy54-capacity-orders-v1'
const LOCK_KEY = 'yy54-capacity-submit-lock-v1'
const FAIL_KEY = 'yy54-capacity-weak-network-v1'
const LOCK_TTL_MS = 12_000

export interface SubmitInput {
  orderNo: string
  windowKey: string
  date: string
  slot: number
  linkId: string
  amount: number
  terminal: CapacityOrder['terminal']
  requestedMode: '放行' | '排队'
  sourceId: string
  sourceLabel: string
  basisVersion: number
}

export interface SubmitResult {
  ok: boolean
  code?: 'WINDOW_TAKEN' | 'LOCK_BUSY' | 'TRANSPORT_LOST'
  order?: CapacityOrder
  /** 竞争失败时占用该窗口的现场单号与终端 */
  heldBy?: { orderNo: string; terminal: CapacityOrder['terminal'] }
  /** 故障时服务端是否实际入账（响应丢失场景），调用方只知道“不明”，恢复时才揭晓 */
  serverApplied?: boolean
}

interface ServerState { orders: CapacityOrder[]; releaseByWindow: Record<string, string> }
interface LockState { holder: string; ts: number }

function tabId(): string {
  let id = sessionStorage.getItem('yy54-capacity-tab-id')
  if (!id) { id = `TAB-${Math.random().toString(36).slice(2, 8)}`; sessionStorage.setItem('yy54-capacity-tab-id', id) }
  return id
}

function readState(): ServerState {
  try {
    const raw = localStorage.getItem(ORDERS_KEY)
    if (raw) return JSON.parse(raw) as ServerState
  } catch { /* ignore */ }
  return { orders: [], releaseByWindow: {} }
}
function writeState(state: ServerState) { localStorage.setItem(ORDERS_KEY, JSON.stringify(state)) }

function readLock(): LockState | null {
  try {
    const raw = localStorage.getItem(LOCK_KEY)
    if (raw) return JSON.parse(raw) as LockState
  } catch { /* ignore */ }
  return null
}
function clearLockIfMine() {
  const lock = readLock()
  if (lock?.holder === tabId()) localStorage.removeItem(LOCK_KEY)
}

/** 跨终端互斥：同刻竞争时以锁里最终留下的 holder 为准，输家立即退出不重试 */
function acquireLock(): boolean {
  const me = tabId()
  const now = Date.now()
  const existing = readLock()
  if (existing && existing.holder !== me && now - existing.ts < LOCK_TTL_MS) return false
  localStorage.setItem(LOCK_KEY, JSON.stringify({ holder: me, ts: now }))
  const winner = readLock()
  return winner?.holder === me
}

const delay = () => new Promise((resolve) => setTimeout(resolve, 280 + Math.random() * 420))

export function weakNetworkEnabled(): boolean { return localStorage.getItem(FAIL_KEY) === '1' }
export function setWeakNetwork(enabled: boolean) {
  localStorage.setItem(FAIL_KEY, enabled ? '1' : '0')
  localStorage.setItem('yy54-capacity-fail-broadcast', String(Date.now()))
}

export function subscribeOrders(listener: () => void): () => void {
  const handler = (event: StorageEvent) => {
    if (event.key === ORDERS_KEY || event.key === LOCK_KEY || event.key === FAIL_KEY) listener()
  }
  window.addEventListener('storage', handler)
  return () => window.removeEventListener('storage', handler)
}

export function listOrders(): CapacityOrder[] { return readState().orders }
export function queryOrder(orderNo: string): CapacityOrder | null {
  return readState().orders.find((item) => item.orderNo === orderNo) ?? null
}

function persistOrder(state: ServerState, order: CapacityOrder) {
  const index = state.orders.findIndex((item) => item.orderNo === order.orderNo)
  if (index >= 0) {
    // 同号只允许把“写入不明/旧版本”补登为服务端真相，不允许改出第二笔
    state.orders[index] = { ...state.orders[index], ...order, createdAt: state.orders[index].createdAt }
  } else {
    state.orders.push(order)
  }
  if (order.mode === '放行' && order.status === '已放行') state.releaseByWindow[order.windowKey] = order.orderNo
}

/** 提交一笔窗口申请（同号重提即幂等恢复） */
export async function submitOrder(input: SubmitInput): Promise<SubmitResult> {
  const me = tabId()
  // 幂等快路径：单号已存在，原样返回，绝不重复占位
  const existing = queryOrder(input.orderNo)
  if (existing) return { ok: true, order: existing }

  if (!acquireLock()) {
    const state = readState()
    const holderNo = state.releaseByWindow[input.windowKey]
    const holderOrder = holderNo ? state.orders.find((o) => o.orderNo === holderNo) : undefined
    return {
      ok: false, code: 'LOCK_BUSY',
      heldBy: holderNo ? { orderNo: holderNo, terminal: holderOrder?.terminal ?? '终端A' } : undefined,
    }
  }

  await delay()
  try {
    const state = readState()
    const afterWait = readLock()
    if (!afterWait || afterWait.holder !== me) {
      return { ok: false, code: 'LOCK_BUSY' }
    }

    // 唯一约束：同一半小时窗口只允许一笔“已放行”
    const heldNo = state.releaseByWindow[input.windowKey]
    if (input.requestedMode === '放行' && heldNo) {
      const holder = state.orders.find((o) => o.orderNo === heldNo)
      return { ok: false, code: 'WINDOW_TAKEN', heldBy: { orderNo: heldNo, terminal: holder?.terminal ?? '终端A' } }
    }

    const now = Date.now()
    const order: CapacityOrder = {
      orderNo: input.orderNo,
      windowKey: input.windowKey,
      date: input.date,
      slot: input.slot,
      linkId: input.linkId,
      amount: input.amount,
      terminal: input.terminal,
      mode: input.requestedMode,
      sourceId: input.sourceId,
      sourceLabel: input.sourceLabel,
      basisVersion: input.basisVersion,
      status: input.requestedMode === '放行' ? '已放行' : '排队中',
      createdAt: now,
    }

    if (weakNetworkEnabled()) {
      // 模拟不明故障：一半概率服务端其实已落账（响应丢失），一半根本没写
      const applied = Math.random() < 0.5
      if (applied) { persistOrder(state, order); writeState(state) }
      return { ok: false, code: 'TRANSPORT_LOST', serverApplied: applied }
    }

    persistOrder(state, order)
    writeState(state)
    return { ok: true, order }
  } finally {
    clearLockIfMine()
  }
}

export function nextOrderNo(): string {
  const seq = Number(sessionStorage.getItem('yy54-capacity-order-seq') ?? '0') + 1
  sessionStorage.setItem('yy54-capacity-order-seq', String(seq))
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  return `YD${day}-${String(seq).padStart(3, '0')}`
}

/** 管理端：撤销排队单（排队不占窗口，仅改状态；已放行单不在此撤销） */
export function cancelQueuedOrder(orderNo: string): CapacityOrder | null {
  const state = readState()
  const order = state.orders.find((o) => o.orderNo === orderNo)
  if (!order || order.status !== '排队中') return order ?? null
  order.status = '已失效'
  writeState(state)
  return order
}

/** 管理端：清空服务端预占（演示重置） */
export function resetAllOrders() { writeState({ orders: [], releaseByWindow: {} }) }

export function statusOf(order: CapacityOrder): OrderStatus { return order.status }
