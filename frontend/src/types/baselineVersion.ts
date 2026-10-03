/** 要素基准变更来源 */
export type BaselineSource = '初始登记' | '差异回写' | '手工修正'

/**
 * 要素基准版本：连戏要素 initialState（基准）的每次变更留档。
 * 要素行只保留当前基准，旧基准进历史表，构成要素基准侧的可追溯链：
 * 初始登记 → 差异解决回写 → 手工修正，每一代都可查。
 */
export interface BaselineVersion {
  id: string
  /** 所属连戏要素 */
  elementId: string
  /** 要素内基准代次（从 1 递增） */
  version: number
  /** 该代基准内容 */
  state: string
  /** 变更来源 */
  source: BaselineSource
  /** 关联差异（差异回写时记录是哪条差异触发的） */
  conflictId: string
  /** 关联现场记录（差异回写时以哪条记录为准） */
  recordId: string
  /** 备注 */
  note: string
  /** 快照时间（毫秒时间戳） */
  createdAt: number
}

export type BaselineVersionRow = BaselineVersion

/** 生成新一代要素基准快照 */
export function createBaselineVersion(
  elementId: string,
  version: number,
  state: string,
  source: BaselineSource,
  ids: { id: string; conflictId?: string; recordId?: string; note?: string },
  createdAt: number
): BaselineVersion {
  return {
    id: ids.id,
    elementId,
    version,
    state,
    source,
    conflictId: ids.conflictId ?? '',
    recordId: ids.recordId ?? '',
    note: ids.note ?? '',
    createdAt
  }
}
