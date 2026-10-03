/** 差异严重程度 */
export type ConflictSeverity = '轻微' | '需处理' | '阻断'
/** 差异处理状态：待确认 / 已解决 为当前结论；待重算 为旧结论留档（不参与统计） */
export type ConflictState = '待确认' | '已解决' | '待重算'

/** 留档状态：现场记录变动后旧结论的归宿，不参与统计与列表 */
export const ARCHIVED_CONFLICT_STATE: ConflictState = '待重算'

/** 连戏差异：同一要素两次现场记录之间的字段级偏差 */
export interface Conflict {
  id: string
  /** 连戏要素 */
  elementId: string
  /** 较早的记录 */
  recordIdA: string
  /** 较晚的记录 */
  recordIdB: string
  /** 差异描述 */
  diffDesc: string
  /** 严重程度 */
  severity: ConflictSeverity
  /** 处理状态 */
  state: ConflictState
  /** 解决留痕（解决时间与处理说明） */
  resolvedNote: string
  /** 解决时间（ISO，未解决为空串） */
  resolvedAt: string
  /** 要素内差异代次（同一要素每重算一次 +1，与 supersedes 构成版本链） */
  version: number
  /** 本代差异取代的上一代差异 id（首代为空串） */
  supersedes: string
  /** 本代差异被哪一代取代（仍为当前结论时为空串） */
  supersededBy: string
  /** 留档 / 待重算原因（旧结论为何作废，如「记录 xxx 已修改」） */
  recalcReason: string
  /** 是否已完成重算处理（待重算横幅只统计 false；重算无差异的旧结论也置 true 留档） */
  recalcDone: boolean
}

export const CONFLICT_SEVERITIES: ConflictSeverity[] = ['轻微', '需处理', '阻断']
/** 筛选下拉只列当前结论状态；待重算走「留档旧结论」开关，不进筛选 */
export const CONFLICT_STATES: ConflictState[] = ['待确认', '已解决']

export function createEmptyConflict(): Omit<
  Conflict,
  | 'id'
  | 'resolvedNote'
  | 'resolvedAt'
  | 'version'
  | 'supersedes'
  | 'supersededBy'
  | 'recalcReason'
  | 'recalcDone'
> {
  return { elementId: '', recordIdA: '', recordIdB: '', diffDesc: '', severity: '轻微', state: '待确认' }
}
