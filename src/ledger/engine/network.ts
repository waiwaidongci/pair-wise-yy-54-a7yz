import type { AdjacentWork, ClosureStage, Corridor, DetourRoute, Scheme } from '../../types'

export type LinkUserType = 'stage' | 'detour' | 'ambulance' | 'bus' | 'adjacent'

export interface LinkUser {
  type: LinkUserType
  id: string
  label: string
}

export interface RoadLink {
  id: string
  a: [number, number]
  b: [number, number]
  users: LinkUser[]
  nominal: number
  sharedWithCorridor: boolean
}

const ROUND = 1000 // 坐标约到 0.001°（约 100 米）作为同一路口节点
const NOMINAL_CAPACITY = 120 // pcu / 30min
// 辅道等窄路段能力下调，按两端节点键匹配
const NARROW_LINKS: Record<string, number> = {
  '121.462,31.219|121.502,31.218': 100, // P7–P9 辅道
  '121.496,31.235|121.502,31.218': 90, // P9–P4 辅道三口（绕行/急救/公交三方共线）
}

function keyOf(point: [number, number]): string {
  return `${Math.round(point[0] * ROUND) / ROUND},${Math.round(point[1] * ROUND) / ROUND}`
}
function edgeKey(a: [number, number], b: [number, number]): string {
  const ka = keyOf(a)
  const kb = keyOf(b)
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`
}

interface LinkBuilder {
  id: string
  a: [number, number]
  b: [number, number]
  users: LinkUser[]
}

function addPolyline(map: Map<string, LinkBuilder>, coordinates: [number, number][], user: LinkUser) {
  for (let i = 0; i < coordinates.length - 1; i += 1) {
    const key = edgeKey(coordinates[i], coordinates[i + 1])
    const existing = map.get(key)
    if (existing) {
      if (!existing.users.some((item) => item.type === user.type && item.id === user.id)) existing.users.push(user)
    } else {
      map.set(key, { id: `L${map.size + 1}`, a: coordinates[i], b: coordinates[i + 1], users: [user] })
    }
  }
}

function stageLabel(stage: ClosureStage) {
  return { id: stage.id, label: stage.name.replace(/ · .*$/, ''), type: 'stage' as const }
}

/** 把阶段围挡、绕行、急救/公交保底通道、相邻工程压到同一张路链图上 */
export function buildRoadGraph(scheme: Scheme): RoadLink[] {
  const map = new Map<string, LinkBuilder>()
  scheme.stages.forEach((stage) => addPolyline(map, stage.route, stageLabel(stage)))
  scheme.detours.forEach((route: DetourRoute) => addPolyline(map, route.coordinates, { type: 'detour', id: route.id, label: route.name }))
  addPolyline(map, scheme.ambulanceCorridor.coordinates, { type: 'ambulance', id: scheme.ambulanceCorridor.id, label: scheme.ambulanceCorridor.name })
  addPolyline(map, scheme.busCorridor.coordinates, { type: 'bus', id: scheme.busCorridor.id, label: scheme.busCorridor.name })
  scheme.adjacentWorks.forEach((work: AdjacentWork) => addPolyline(map, work.occupyCoordinates, { type: 'adjacent', id: work.id, label: work.name }))
  return [...map.entries()].map(([key, link]) => ({
    ...link,
    nominal: NARROW_LINKS[key] ?? NOMINAL_CAPACITY,
    sharedWithCorridor: link.users.some((u) => u.type === 'detour' || u.type === 'stage')
      && link.users.some((u) => u.type === 'ambulance' || u.type === 'bus'),
  }))
}

/** 路链上的通道保底 */
export function linkReservations(link: RoadLink, ambulance: Corridor, bus: Corridor, slot: number) {
  const out: { kind: '急救保底' | '公交保底'; id: string; label: string; amount: number }[] = []
  const inService = (corridor: Corridor) => corridor.service.some((w) => slot >= w.startSlot && slot <= w.endSlot)
  link.users.forEach((user) => {
    if (user.type === 'ambulance' && inService(ambulance)) out.push({ kind: '急救保底', id: ambulance.id, label: `${ambulance.name}（急救最低能力）`, amount: ambulance.minCapacity })
    if (user.type === 'bus' && inService(bus)) out.push({ kind: '公交保底', id: bus.id, label: `${bus.name}（公交最低能力）`, amount: bus.minCapacity })
  })
  return out
}

/** 路链在指定日期、半小时下的围挡/相邻工程能力扣减 */
export function linkReductions(link: RoadLink, scheme: Scheme, date: string, slot: number) {
  const out: { id: string; label: string; amount: number }[] = []
  const active = (windows: { startSlot: number; endSlot: number }[]) => windows.some((w) => slot >= w.startSlot && slot <= w.endSlot)
  scheme.stages.forEach((stage) => {
    if (stage.status === '退回' || !stage.closure || date < stage.start || date > stage.end) return
    if (!active(stage.closure.windows)) return
    if (!link.users.some((u) => u.type === 'stage' && u.id === stage.id)) return
    const mitigated = stage.closure.basisCommentId
      && scheme.comments.some((c) => c.id === stage.closure!.basisCommentId && c.status === '已接受')
    out.push({ id: stage.id, label: `${stage.name.replace(/ · .*$/, '')}围挡扣减${mitigated ? '（已按会签条件缩窄）' : ''}`, amount: mitigated ? stage.closure.mitigatedReduction : stage.closure.reduction })
  })
  scheme.adjacentWorks.forEach((work) => {
    if (date < work.start || date > work.end || !active(work.windows)) return
    if (!link.users.some((u) => u.type === 'adjacent' && u.id === work.id)) return
    out.push({ id: work.id, label: `${work.name}占用`, amount: work.reduction })
  })
  return out
}

/** 会签条件接受后对路链补充的放行能力（信号配时优化等） */
export function linkMitigations(link: RoadLink, scheme: Scheme, date: string, slot: number) {
  const out: { id: string; label: string; amount: number }[] = []
  scheme.stages.forEach((stage) => {
    const mitigation = stage.demand?.mitigation
    if (!mitigation || stage.status === '退回' || date < stage.start || date > stage.end) return
    if (!stage.demand!.windows.some((w) => slot >= w.startSlot && slot <= w.endSlot)) return
    if (!scheme.comments.some((c) => c.id === mitigation.basisCommentId && c.status === '已接受')) return
    const detour = scheme.detours.find((d) => d.id === stage.demand!.detourId)
    if (!detour || !link.users.some((u) => u.type === 'detour' && u.id === detour.id)) return
    out.push({ id: mitigation.basisCommentId, label: `会签 ${mitigation.basisCommentId} 信号配时补能力`, amount: mitigation.extraCapacity })
  })
  return out
}

/** 阶段社会绕行需求在指定日期、半小时落到哪些路链、多少量 */
export function stageDemandOnLink(link: RoadLink, scheme: Scheme, date: string, slot: number) {
  const out: { id: string; label: string; amount: number }[] = []
  scheme.stages.forEach((stage) => {
    const demand = stage.demand
    if (!demand || stage.status === '退回' || date < stage.start || date > stage.end) return
    if (!demand.windows.some((w) => slot >= w.startSlot && slot <= w.endSlot)) return
    const detour = scheme.detours.find((d) => d.id === demand.detourId)
    if (!detour) return
    const onLink = link.users.some((u) => u.type === 'detour' && u.id === detour.id)
    if (!onLink) return
    const amount = Math.round(demand.base * (demand.peakFactor?.[slot] ?? 1))
    out.push({ id: stage.id, label: `${stage.name.replace(/ · .*$/, '')}社会绕行（${detour.name}）`, amount })
  })
  return out
}
