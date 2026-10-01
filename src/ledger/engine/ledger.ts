import type { CapacityOrder, Scheme } from '../../types'
import { linkReductions, linkReservations, linkMitigations, stageDemandOnLink, type RoadLink } from './network'

export interface ReservationItem { kind: '急救保底' | '公交保底'; id: string; label: string; amount: number }
export interface ReductionItem { id: string; label: string; amount: number }
export interface DemandItem { id: string; label: string; amount: number }
export interface OrderItem { orderNo: string; sourceId: string; sourceLabel: string; amount: number }

export interface LedgerRow {
  key: string
  date: string
  slot: number
  slotLabel: string
  linkId: string
  usersText: string
  nominal: number
  reductions: ReductionItem[]
  mitigations: ReductionItem[]
  reservations: ReservationItem[]
  /** 扣减与保底后的剩余能力（不允许为负，保底是硬预留） */
  available: number
  detourDemand: DemandItem[]
  releasedOrders: OrderItem[]
  queuedOrders: OrderItem[]
  /** 社会绕行 + 已放行预占合计 */
  applied: number
  /** 剩余能力 - 已申报量；<0 即容量不足 */
  balance: number
  shortfall: number
  /** 排队中尚未获得窗口能力的量（占用来源已登记） */
  queued: number
  /** 亏空中尚未被排队申请覆盖的部分 */
  uncoveredShortfall: number
  sharedWithCorridor: boolean
}

export function slotLabel(slot: number): string {
  const hh = Math.floor(slot / 2)
  const mm = slot % 2 === 0 ? '00' : '30'
  const start = `${String(hh).padStart(2, '0')}:${mm}`
  const endSlot = slot + 1
  const eh = Math.floor(endSlot / 2)
  const em = endSlot % 2 === 0 ? '00' : '30'
  return `${start}–${String(eh).padStart(2, '0')}:${em}`
}

export function dateRange(scheme: Scheme): string[] {
  const dates = scheme.stages
    .filter((s) => s.status !== '退回')
    .map((s) => [s.start, s.end])
    .sort((a, b) => a[0].localeCompare(b[0]))
  if (!dates.length) return []
  const out: string[] = []
  const cursor = dates[0][0]
  const last = dates.reduce((acc, pair) => (pair[1] > acc ? pair[1] : acc), dates[0][1])
  const toDate = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)) }
  const cur = toDate(cursor)
  const end = toDate(last)
  while (cur <= end) {
    const iso = cur.toISOString().slice(0, 10)
    if (scheme.stages.some((s) => s.status !== '退回' && iso >= s.start && iso <= s.end)) out.push(iso)
    cur.setUTCDate(cur.getUTCDate() + 1)
  }
  return out
}

/** 半小时道路容量账：急救、公交保底先扣，再算围挡扣减，最后核社会绕行与已放行预占 */
export function buildLedger(scheme: Scheme, links: RoadLink[], orders: CapacityOrder[]): LedgerRow[] {
  const rows: LedgerRow[] = []
  dateRange(scheme).forEach((date) => {
    links.forEach((link) => {
      for (let slot = 0; slot < 48; slot += 1) {
        const reservations = linkReservations(link, scheme.ambulanceCorridor, scheme.busCorridor, slot)
        const reductions = linkReductions(link, scheme, date, slot)
        const mitigations = linkMitigations(link, scheme, date, slot)
        const detourDemand = stageDemandOnLink(link, scheme, date, slot)
        const releasedOrders = orders
          .filter((o) => o.status === '已放行' && o.date === date && o.slot === slot && o.linkId === link.id && o.basisVersion === scheme.ledgerVersion)
          .map((o) => ({ orderNo: o.orderNo, sourceId: o.sourceId, sourceLabel: o.sourceLabel, amount: o.amount }))
        const queuedOrders = orders
          .filter((o) => o.status === '排队中' && o.date === date && o.slot === slot && o.linkId === link.id && o.basisVersion === scheme.ledgerVersion)
          .map((o) => ({ orderNo: o.orderNo, sourceId: o.sourceId, sourceLabel: o.sourceLabel, amount: o.amount }))
        if (!reservations.length && !reductions.length && !mitigations.length && !detourDemand.length && !releasedOrders.length && !queuedOrders.length) continue
        const reductionTotal = reductions.reduce((sum, item) => sum + item.amount, 0)
        const mitigationTotal = mitigations.reduce((sum, item) => sum + item.amount, 0)
        const reserveTotal = reservations.reduce((sum, item) => sum + item.amount, 0)
        // 急救/公交为硬预留：保底被围挡挤占时不允许，账上直接计亏空
        const afterReduction = link.nominal - reductionTotal + mitigationTotal
        const available = Math.max(0, afterReduction - reserveTotal)
        const applied = detourDemand.reduce((sum, item) => sum + item.amount, 0)
          + releasedOrders.reduce((sum, item) => sum + item.amount, 0)
        const queued = queuedOrders.reduce((sum, item) => sum + item.amount, 0)
        const balance = available - applied
        const shortfall = balance < 0 ? -balance : 0
        const uncoveredShortfall = Math.max(0, shortfall - queued)
        rows.push({
          key: `${date}|${slot}|${link.id}`, date, slot, slotLabel: slotLabel(slot), linkId: link.id,
          usersText: link.users.map((u) => u.label).join(' / '),
          nominal: link.nominal, reductions, mitigations, reservations, available, detourDemand, releasedOrders, queuedOrders,
          applied, balance, shortfall, queued, uncoveredShortfall, sharedWithCorridor: link.sharedWithCorridor,
        })
      }
    })
  })
  return rows
}

export interface CapacityGate {
  ledgerVersion: number
  deficitRows: number
  uncoveredDeficitRows: number
  queuedOrders: number
  unknownOrders: number
  staleOrders: number
  staleComments: number
  ready: boolean
  reasons: string[]
}

/**
 * 通告导出闸门：
 * - 亏空窗口必须逐窗“申请排队并标明占用来源”，覆盖全部亏空才算处置完成
 * - 写入未知、旧版本预占未重算、失效会签未重签，任一存在即挡住
 */
export function exportGate(scheme: Scheme, rows: LedgerRow[], orders: CapacityOrder[]): CapacityGate {
  const reasons: string[] = []
  const deficitRows = rows.filter((r) => r.shortfall > 0).length
  const uncoveredDeficitRows = rows.filter((r) => r.uncoveredShortfall > 0).length
  const queuedOrders = orders.filter((o) => o.status === '排队中').length
  const unknownOrders = orders.filter((o) => o.status === '写入未知').length
  const staleOrders = orders.filter((o) => (o.status === '已放行' || o.status === '排队中') && o.basisVersion !== scheme.ledgerVersion).length
  const staleComments = scheme.comments.filter((c) => c.status === '失效待重签').length
  if (uncoveredDeficitRows) reasons.push(`${uncoveredDeficitRows} 个半小时窗口容量亏空尚未处置：须申请排队并标明占用来源，或调整方案/接受会签补能`)
  if (unknownOrders) reasons.push(`${unknownOrders} 笔现场单号写入结果未知，须按单号恢复，禁止重复占位`)
  if (staleOrders) reasons.push(`${staleOrders} 笔预占锚定旧账版本，须重算后才能导出`)
  if (staleComments) reasons.push(`${staleComments} 条会签意见因阶段变更已失效，须重签`)
  return { ledgerVersion: scheme.ledgerVersion, deficitRows, uncoveredDeficitRows, queuedOrders, unknownOrders, staleOrders, staleComments, ready: reasons.length === 0, reasons }
}
