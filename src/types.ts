export type StageStatus = '待协商' | '条件通过' | '已批准' | '退回'

export interface ClosureStage {
  id: string
  name: string
  start: string
  end: string
  lanes: string
  status: StageStatus
  route: [number, number][]
}

export interface DetourRoute {
  id: string
  name: string
  distance: number
  extraMinutes: number
  coordinates: [number, number][]
}

export interface SegmentComment {
  id: string
  segmentId: string
  unit: '建设' | '交通' | '公交' | '应急'
  author: string
  content: string
  condition?: string
  status: '待处理' | '已接受' | '已退回'
  invalid?: boolean
}

export interface Scheme {
  id: string
  project: string
  contractor: string
  area: string
  version: number
  stages: ClosureStage[]
  detours: DetourRoute[]
  comments: SegmentComment[]
}

// 半小时道路容量账
export type CapacityRoadId = 'main' | 'dr-01' | 'dr-02'
export type OccupationSourceType = 'stage' | 'detour'
export type OccupationStatus = 'reserved' | 'invalid'
export type SubmitOutcome = 'admitted' | 'queued' | 'conflict' | 'duplicate'
export type RecoveryState = 'idle' | 'recalculating' | 'recovered'

export interface CapacityWindow {
  windowId: string          // 例 2026-10-08T08:00/08:30#main
  date: string
  start: string
  end: string
  roadId: CapacityRoadId
  roadName: string
  total: number             // 半小时总容量（PCU）
  reservedEmergency: number // 急救通道先留足
  reservedBus: number       // 公交最低能力先留足
  version: number           // 乐观锁版本
}

export interface Occupation {
  id: string
  orderNo: string           // 现场单号（幂等键）
  windowId: string
  roadId: CapacityRoadId
  sourceType: OccupationSourceType
  sourceId: string
  sourceName: string
  amount: number
  status: OccupationStatus
  linkedCommentIds: string[] // 关联会签意见
  createdAt: number
}

export interface QueueEntry {
  id: string
  orderNo: string
  windowId: string
  roadId: CapacityRoadId
  sourceType: OccupationSourceType
  sourceId: string
  sourceName: string
  amount: number
  reason: string
  blockedBy: { sourceName: string; amount: number; type: OccupationSourceType | 'emergency' | 'bus' }[] // 占用来源
  status: 'waiting' | 'admitted' | 'cancelled'
  requestedAt: number
}

export interface FailedOrder {
  orderNo: string
  objectType: OccupationSourceType
  objectId: string
  objectName: string
  at: number
}

export interface SubmitResult {
  outcome: SubmitOutcome
  windowId: string
  orderNo: string
  amount: number
  occupation?: Occupation
  queueEntry?: QueueEntry
  heldBy?: string
  holderSource?: string
}
