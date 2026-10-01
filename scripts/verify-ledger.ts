import { buildRoadGraph } from '../src/ledger/engine/network'
import { buildLedger, exportGate } from '../src/ledger/engine/ledger'

const P0: [number, number] = [121.452, 31.224], P1: [number, number] = [121.462, 31.226], P2: [number, number] = [121.47, 31.228], P3: [number, number] = [121.482, 31.231], P4: [number, number] = [121.496, 31.235], P5: [number, number] = [121.508, 31.238], P6: [number, number] = [121.516, 31.242], P7: [number, number] = [121.462, 31.219], P8: [number, number] = [121.478, 31.214], P9: [number, number] = [121.502, 31.218]
const A0: [number, number] = [121.476, 31.208], B0: [number, number] = [121.45, 31.217]

function schemeSeed(overrides: Record<string, any> = {}): any {
  const s: any = {
    id: 'RC-1', project: 'p', contractor: 'c', area: 'a', version: 7, ledgerVersion: 1,
    stages: [
      { id: 'ST-01', name: '第一阶段 · 围挡', start: '2026-10-08', end: '2026-10-22', lanes: '', status: '条件通过', route: [P2, P3, P4],
        demand: { detourId: 'DR-02', base: 34, windows: [{ startSlot: 12, endSlot: 42 }], peakFactor: { 16: 1.35, 17: 1.35, 35: 1.3 }, mitigation: { basisCommentId: 'CM-44', extraCapacity: 12 } },
        closure: { reduction: 18, mitigatedReduction: 18, windows: [{ startSlot: 0, endSlot: 47 }] } },
      { id: 'ST-02', name: '第二阶段 · 夜施', start: '2026-10-23', end: '2026-11-05', lanes: '', status: '待协商', route: [P9, P5, P6],
        demand: { detourId: 'DR-01', base: 50, windows: [{ startSlot: 44, endSlot: 47 }, { startSlot: 0, endSlot: 9 }] },
        closure: { reduction: 45, mitigatedReduction: 30, windows: [{ startSlot: 44, endSlot: 47 }, { startSlot: 0, endSlot: 9 }], basisCommentId: 'CM-42' } },
      { id: 'ST-03', name: '第三阶段 · 退回', start: '2026-11-06', end: '2026-11-18', lanes: '', status: '退回', route: [P0, P1, P2],
        demand: { detourId: 'DR-02', base: 20, windows: [{ startSlot: 12, endSlot: 42 }] }, closure: { reduction: 10, mitigatedReduction: 10, windows: [{ startSlot: 0, endSlot: 47 }] } },
    ],
    detours: [
      { id: 'DR-01', name: '江海绕行', distance: 4.8, extraMinutes: 11, coordinates: [P2, P8, P9, P5, P6] },
      { id: 'DR-02', name: '辅道保通', distance: 2.3, extraMinutes: 6, coordinates: [P0, P7, P9, P4] },
    ],
    ambulanceCorridor: { id: 'AM-01', name: '急救通道', kind: '急救', minCapacity: 30, service: [{ startSlot: 0, endSlot: 47 }], coordinates: [A0, P8, P9, P4, P9, P5] },
    busCorridor: { id: 'BS-01', name: '公交通廊', kind: '公交', minCapacity: 20, service: [{ startSlot: 10, endSlot: 43 }], coordinates: [B0, P7, P9, P4, P5] },
    adjacentWorks: [{ id: 'AJ-01', name: '雨污', start: '2026-10-26', end: '2026-10-30', windows: [{ startSlot: 44, endSlot: 47 }, { startSlot: 0, endSlot: 9 }], reduction: 15, occupyCoordinates: [P9, P5] }],
    comments: [
      { id: 'CM-42', segmentId: 'ST-02', unit: '应急', author: 'x', content: '', condition: '', status: '待处理' },
      { id: 'CM-44', segmentId: 'ST-01', unit: '交通', author: 'x', content: '', condition: '', status: '待处理' },
    ],
  }
  Object.assign(s, overrides)
  return s
}

let pass = 0, fail = 0
function check(name: string, cond: boolean, extra = '') { if (cond) { pass += 1; console.log(`  ✓ ${name}`) } else { fail += 1; console.error(`  ✗ ${name} ${extra}`) } }

console.log('1) 路网：识别公交和急救与社会绕行的共用路面')
const scheme = schemeSeed()
const links = buildRoadGraph(scheme)
const triple = links.find((l) => l.users.some((u) => u.type === 'detour' && u.id === 'DR-02') && l.users.some((u) => u.type === 'ambulance') && l.users.some((u) => u.type === 'bus'))
check('辅道三口 P9–P4 三方共线', !!triple, triple?.id ?? '')
check('三方共线路段能力按窄路下调为 90', triple!.nominal === 90, String(triple!.nominal))
const nightShared = links.find((l) => l.users.some((u) => u.type === 'detour' && u.id === 'DR-01') && l.users.some((u) => u.type === 'ambulance') && l.users.some((u) => u.type === 'stage' && u.id === 'ST-02'))
check('夜间 P9–P5 绕行/急救/围挡共线', !!nightShared, nightShared?.id ?? '')

console.log('2) 保底先扣：ST-01 早高峰三方共线亏空 6，占用来源是社会绕行')
let rows = buildLedger(scheme, links, [])
const peak = rows.find((r) => r.date === '2026-10-08' && r.slot === 16 && r.linkId === triple!.id)!
check('急救保底30、公交保底20均预留', peak.reservations.some((r) => r.kind === '急救保底' && r.amount === 30) && peak.reservations.some((r) => r.kind === '公交保底' && r.amount === 20))
check('剩余能力 40（90-30-20）', peak.available === 40, String(peak.available))
check('高峰社会绕行 46', peak.detourDemand[0].amount === 46, String(peak.detourDemand[0].amount))
check('亏空 6 且未覆盖', peak.shortfall === 6 && peak.uncoveredShortfall === 6, `sf=${peak.shortfall} un=${peak.uncoveredShortfall}`)
check('平峰平衡（40≥34，余6）', rows.find((r) => r.date === '2026-10-08' && r.slot === 12 && r.linkId === triple!.id)!.balance === 6)

console.log('3) 会签补能：接受 CM-44 后高峰平衡')
const s44 = schemeSeed(); s44.comments.find((c: any) => c.id === 'CM-44').status = '已接受'
const rows44 = buildLedger(s44, buildRoadGraph(s44), [])
const peak44 = rows44.find((r) => r.date === '2026-10-08' && r.slot === 16 && r.linkId === triple!.id)!
check('接受信号配时后补 +12，剩余 52 ≥ 46', peak44.available === 52 && peak44.shortfall === 0, `avail=${peak44.available}`)

console.log('4) 夜间急救：CM-42 未接受亏空 5；接受后平衡')
const night0 = rows.find((r) => r.date === '2026-10-23' && r.slot === 0 && r.linkId === nightShared!.id)!
check('未接受 CM-42：120-45围挡-30急救=45 < 需求50，亏 5', night0.available === 45 && night0.shortfall === 5, `avail=${night0.available} sf=${night0.shortfall}`)
const s42 = schemeSeed(); s42.comments.find((c: any) => c.id === 'CM-42').status = '已接受'
const rows42 = buildLedger(s42, buildRoadGraph(s42), [])
const night42 = rows42.find((r) => r.date === '2026-10-23' && r.slot === 0 && r.linkId === nightShared!.id)!
check('接受 CM-42 围挡内收：60 ≥ 50，平衡', night42.available === 60 && night42.shortfall === 0)
const nightOverlap = rows42.find((r) => r.date === '2026-10-26' && r.slot === 0 && r.linkId === nightShared!.id)!
check('相邻工程叠加夜仍亏 5（120-30-15-30=45<50）', nightOverlap.shortfall === 5, String(nightOverlap.shortfall))

console.log('5) 退回阶段 ST-03 不入账')
check('11-06 之后无账行', !rows.some((r) => r.date >= '2026-11-06'))

console.log('6) 导出闸门：亏空未排队挡住；逐窗排队覆盖后放行')
let gate = exportGate(scheme, rows, [])
check('初始有未覆盖亏空 → 挡住', !gate.ready && gate.uncoveredDeficitRows > 0)
// 对 10-08 早高峰那笔亏空排队 6
const queuedOrder: any = { orderNo: 'Q1', windowKey: 'w', date: '2026-10-08', slot: 16, linkId: triple!.id, amount: 6, terminal: '终端A', mode: '排队', sourceId: 'ST-01', sourceLabel: '社会绕行', basisVersion: 1, status: '排队中', createdAt: 1 }
const rowsQ = buildLedger(scheme, links, [queuedOrder])
const peakQ = rowsQ.find((r) => r.date === '2026-10-08' && r.slot === 16 && r.linkId === triple!.id)!
check('排队 6 后该窗 uncovered=0（亏空仍在但已登记排队）', peakQ.shortfall === 6 && peakQ.uncoveredShortfall === 0 && peakQ.queued === 6)

console.log('7) 旧版本预占不进入新账，闸门要求重算')
const stale: any = { ...queuedOrder, orderNo: 'OLD', basisVersion: 0, status: '已放行', amount: 6 }
const gateStale = exportGate(scheme, buildLedger(scheme, links, [stale]), [stale])
check('旧版本已放行单不计入新账且闸门提示重算', gateStale.staleOrders === 1 && !gateStale.ready)

console.log('8) 全场景缓解后（接受 CM-42/CM-44 + 相邻错峰移除）可放行')
const sAll = schemeSeed()
sAll.comments.find((c: any) => c.id === 'CM-42').status = '已接受'
sAll.comments.find((c: any) => c.id === 'CM-44').status = '已接受'
sAll.adjacentWorks = []
const rowsAll = buildLedger(sAll, buildRoadGraph(sAll), [])
const gateAll = exportGate(sAll, rowsAll, [])
check('无任何亏空 → 闸门放行', gateAll.ready, gateAll.reasons.join(';'))

console.log(`\n引擎结果：${pass} 通过, ${fail} 失败`)
if (fail) process.exit(1)
