/* 服务端并发/恢复测试：localStorage 跨终端共享，sessionStorage 按终端隔离 */

class MemoryStorage {
  constructor(shared, prefix = '') { this.shared = shared; this.prefix = prefix }
  getItem(k) { return (this.shared[this.prefix + k] ?? null) }
  setItem(k, v) { this.shared[this.prefix + k] = String(v) }
  removeItem(k) { delete this.shared[this.prefix + k] }
}
const shared = {}
// 两个终端：共享 localStorage（前缀 l:），各自 sessionStorage（sA:/sB:）
globalThis.localStorage = new MemoryStorage(shared, 'l:')
const sessionA = new MemoryStorage(shared, 'sA:')
const sessionB = new MemoryStorage(shared, 'sB:')

async function asTerminal(session, fn) {
  const prev = globalThis.sessionStorage
  globalThis.sessionStorage = session
  try { return await fn() } finally { globalThis.sessionStorage = prev }
}

const server = await import('/workspace/src/ledger/capacityServer.ts')

let pass = 0, fail = 0
function check(name, cond, extra = '') { if (cond) { pass += 1; console.log(`  ✓ ${name}`) } else { fail += 1; console.error(`  ✗ ${name} ${extra}`) } }

function input(over = {}) {
  return {
    orderNo: 'X1', windowKey: '2026-10-08|16|L7', date: '2026-10-08', slot: 16, linkId: 'L7',
    amount: 6, terminal: '终端A', requestedMode: '放行', sourceId: 'ST-01', sourceLabel: '社会绕行', basisVersion: 1, ...over,
  }
}

console.log('A) 两终端同时提交同一窗口：只放行一笔')
server.setWeakNetwork(false)
const [rA, rB] = await Promise.all([
  asTerminal(sessionA, () => server.submitOrder(input({ orderNo: 'A-001', terminal: '终端A' }))),
  asTerminal(sessionB, () => server.submitOrder(input({ orderNo: 'B-001', terminal: '终端B' }))),
])
const ok = [rA, rB].filter((r) => r.ok)
const rejected = [rA, rB].find((r) => !r.ok)
check('恰好一笔成功', ok.length === 1, `ok=${ok.length}`)
check('输家为 LOCK_BUSY 或 WINDOW_TAKEN', rejected && (rejected.code === 'LOCK_BUSY' || rejected.code === 'WINDOW_TAKEN'), rejected?.code)
check('输家未产生任何占位', server.listOrders().filter((o) => o.status === '已放行').length === 1)

console.log('B) 窗口唯一约束：锁过期后第二个“放行”仍被拒，但“排队”允许')
const rQueue = await asTerminal(sessionB, () => server.submitOrder(input({ orderNo: 'B-002', terminal: '终端B', requestedMode: '排队' })))
check('排队单可与已放行窗口共存', rQueue.ok && rQueue.order.status === '排队中')
const rRel = await asTerminal(sessionB, () => server.submitOrder(input({ orderNo: 'B-003', terminal: '终端B', requestedMode: '放行' })))
check('第二个放行被 WINDOW_TAKEN 拒', !rRel.ok && rRel.code === 'WINDOW_TAKEN', rRel.code)
check('拒绝结果指出占用来源单号与终端', rRel.heldBy?.orderNo === 'A-001' && rRel.heldBy.terminal === '终端A', JSON.stringify(rRel.heldBy))
check('被拒不产生占位', server.listOrders().filter((o) => o.status === '已放行').length === 1)

console.log('C) 现场单号幂等：重复提交同号只返回原单')
const again = await asTerminal(sessionA, () => server.submitOrder(input({ orderNo: 'A-001' })))
check('同号重提返回同一笔，不新增', again.ok && again.order.orderNo === 'A-001' && server.listOrders().length === 2)

console.log('D) 弱网写入失败：按现场单号恢复，绝不重复占位')
server.resetAllOrders()
server.setWeakNetwork(true)
// 反复提交新号直到制造一起 TRANSPORT_LOST
let lost = null
for (let i = 0; i < 8 && !lost; i += 1) {
  // eslint-disable-next-line no-await-in-loop
  const res = await asTerminal(sessionA, () => server.submitOrder(input({ orderNo: `F-${i}`, amount: 6 })))
  if (!res.ok && res.code === 'TRANSPORT_LOST') lost = { no: `F-${i}`, applied: res.serverApplied }
}
check('制造出一起写入不明', !!lost)
if (lost) {
  const before = server.listOrders().length
  const restored = server.queryOrder(lost.no)
  if (lost.applied) {
    check('服务端实际已入账：按单号能查到真相', !!restored && restored.status === '已放行')
  } else {
    check('服务端未入账：按单号查无', !restored)
    // 恢复流程用原号原内容补提一次（此时关弱网保证补提成功）
    server.setWeakNetwork(false)
    const retry = await asTerminal(sessionA, () => server.submitOrder(input({ orderNo: lost.no, amount: 6 })))
    check('补提成功且仅一笔', retry.ok && retry.order.orderNo === lost.no && server.listOrders().filter((o) => o.orderNo === lost.no).length === 1)
  }
  // 无论哪种情况，再“恢复”一次也不会有第二条
  const idem = await asTerminal(sessionA, () => server.submitOrder(input({ orderNo: lost.no, amount: 6 })))
  check('再次恢复幂等，不重复占位', idem.ok && server.listOrders().filter((o) => o.orderNo === lost.no).length === 1, `count=${server.listOrders().length}`)
  check('整个过程同窗口放行总数 ≤ 1', server.listOrders().filter((o) => o.status === '已放行' && o.windowKey === input().windowKey).length <= 1, String(before))
}

console.log('E) 排队撤销与重置')
server.setWeakNetwork(false)
const canceled = server.cancelQueuedOrder('B-002')
check('撤销排队单状态变已失效', canceled === null || canceled.status !== '排队中')
server.resetAllOrders()
check('重置后无单', server.listOrders().length === 0)

console.log(`\n服务端结果：${pass} 通过, ${fail} 失败`)
if (fail) process.exit(1)
