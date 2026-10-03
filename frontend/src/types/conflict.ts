/** 差异严重程度 */
export type ConflictSeverity = '轻微' | '需处理' | '阻断'
/**
 * 差异处理状态（版本链生命周期）：
 * - 待确认：新一代差异，等待确认解决，参与统计
 * - 已解决：已确认并回写基准，参与「已解决」统计
 * - 待重算：其依据的旧记录 / 要素基准被修改，旧结论冻结、不参与统计，确认重算后才生成新一代
 * - 已留档：重算后上一代结论留档，仅供追溯，不参与统计
 */
export type ConflictState = '待确认' | '已解决' | '待重算' | '已留档'

/** 参与统计 / 现场提示的生效状态（待重算、已留档均为非生效结论） */
export const ACTIVE_CONFLICT_STATES: ConflictState[] = ['待确认', '已解决']

/** 连戏差异：同一要素两次现场记录之间的字段级偏差（带版本链世代信息） */
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
  /** 版本链分组：同一要素同一对记录的各代差异共享一个分组，串联世代 */
  chainGroup: string
  /** 世代号（从 1 开始，旧记录每次修改后重算 +1） */
  generation: number
  /** 该代差异所依据的较早记录版本 */
  recordAVersion: number
  /** 该代差异所依据的较晚记录版本 */
  recordBVersion: number
  /** 该代差异所依据的要素基准版本（0 表示旧库迁移数据，无基准版本信息） */
  baselineVersion: number
  /** 被哪一条新差异取代（留档时写入） */
  supersededBy: string
  /** 待重算时的动手前快照（JSON 字符串），重算失败或撤销时恢复；重算完成后清空 */
  preRecalcSnapshot: string
}

export const CONFLICT_SEVERITIES: ConflictSeverity[] = ['轻微', '需处理', '阻断']
export const CONFLICT_STATES: ConflictState[] = ['待确认', '已解决', '待重算', '已留档']

export function createEmptyConflict(): Omit<Conflict, 'id' | 'resolvedNote' | 'resolvedAt'> {
  return {
    elementId: '',
    recordIdA: '',
    recordIdB: '',
    diffDesc: '',
    severity: '轻微',
    state: '待确认',
    chainGroup: '',
    generation: 1,
    recordAVersion: 0,
    recordBVersion: 0,
    baselineVersion: 0,
    supersededBy: '',
    preRecalcSnapshot: ''
  }
}
