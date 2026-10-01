export type StageStatus = '待协商' | '条件通过' | '已批准' | '退回'

// 会签状态：阶段时间/路线/车道变更后，锚定该阶段的已接受/待处理意见转为「失效待重签」
export type CommentStatus = '待处理' | '已接受' | '已退回' | '失效待重签'

export type DemandKind = '急救保底' | '公交保底' | '社会绕行'

/** 半小时时段编号：0=00:00–00:30 … 47=23:30–24:00；窗口可跨午夜 */
export interface SlotWindow {
  startSlot: number
  endSlot: number
}

export interface StageDemandProfile {
  /** 该阶段社会车辆导入的绕行路线 */
  detourId: string
  /** 每个半小时窗口的基准需求（pcu/30min） */
  base: number
  /** 当日生效时段（半小时编号，闭区间） */
  windows: SlotWindow[]
  /** 特定半小时的高峰系数（如早晚高峰） */
  peakFactor?: Record<number, number>
  /** 会签条件接受后对该绕行路链补充的放行能力（如信号配时优化） */
  mitigation?: { basisCommentId: string; extraCapacity: number }
}

export interface StageClosure {
  /** 围挡物理占用扣减的路面能力（会签条件未接受时生效） */
  reduction: number
  /** 关联会签条件被接受后的扣减（如保留 4 米应急通道） */
  mitigatedReduction: number
  /** 扣减生效时段 */
  windows: SlotWindow[]
  /** 决定减免是否成立的会签意见号 */
  basisCommentId?: string
}

export interface ClosureStage {
  id: string
  name: string
  start: string
  end: string
  lanes: string
  status: StageStatus
  route: [number, number][]
  /** 社会绕行需求画像；退回阶段不参与容量账 */
  demand?: StageDemandProfile
  /** 围挡对自身路线所在路链的能力扣减 */
  closure?: StageClosure
}

export interface DetourRoute {
  id: string
  name: string
  distance: number
  extraMinutes: number
  coordinates: [number, number][]
}

export interface Corridor {
  id: string
  name: string
  kind: '急救' | '公交'
  /** 每个半小时必须预留的最低能力（pcu/30min） */
  minCapacity: number
  /** 服务时段；急救为 0–47 全天 */
  service: SlotWindow[]
  coordinates: [number, number][]
}

export interface AdjacentWork {
  id: string
  name: string
  start: string
  end: string
  /** 占用时段 */
  windows: SlotWindow[]
  /** 对路链能力的扣减 */
  reduction: number
  /** 计入容量账的实际占用坐标（展示线另在地图上绘制） */
  occupyCoordinates: [number, number][]
}

export interface SegmentComment {
  id: string
  segmentId: string
  unit: '建设' | '交通' | '公交' | '应急'
  author: string
  content: string
  condition?: string
  status: CommentStatus
}

export interface Scheme {
  id: string
  project: string
  contractor: string
  area: string
  version: number
  /** 容量账版本：阶段时间/路线/车道或绕行变化时递增，旧预占据此失效 */
  ledgerVersion: number
  stages: ClosureStage[]
  detours: DetourRoute[]
  ambulanceCorridor: Corridor
  busCorridor: Corridor
  adjacentWorks: AdjacentWork[]
  comments: SegmentComment[]
}

export type OrderStatus = '已放行' | '排队中' | '写入未知' | '已失效'

export interface CapacityOrder {
  /** 现场单号，写入与恢复都以它幂等去重 */
  orderNo: string
  windowKey: string
  date: string
  slot: number
  linkId: string
  /** 申请数量（pcu/30min） */
  amount: number
  terminal: '终端A' | '终端B'
  /** 放行=真实占用剩余能力；排队=不占位，只登记排队 */
  mode: '放行' | '排队'
  /** 该笔申请代表的占用来源（如 ST-01 社会绕行） */
  sourceId: string
  sourceLabel: string
  /** 申请时锚定的容量账版本 */
  basisVersion: number
  status: OrderStatus
  createdAt: number
  note?: string
}
