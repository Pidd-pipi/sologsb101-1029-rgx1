/**
 * 版本链留痕：现场记录 → 连戏差异 → 要素基准 三者每次状态变化都落一条不可变事件，
 * 形成可追溯的版本链。差异的「失效 → 重算 → 归档 / 回滚」全过程据此审计。
 */

/** 留痕挂在哪类实体上 */
export type ChainEntityType = 'record' | 'conflict' | 'element'

/** 版本链事件类型 */
export type ChainActionType =
  | 'record-amended' // 旧现场记录被补记 / 更正
  | 'diff-invalidated' // 旧记录或基准改动后，相关差异冻结为待重算
  | 'diff-regenerated' // 确认重算后生成新一代差异
  | 'diff-archived' // 旧结论留档（不参与统计）
  | 'diff-resolved' // 差异确认解决
  | 'diff-reopened' // 已解决差异重新打开
  | 'element-baseline-changed' // 要素基准（初始状态 / 关键标记）被修改
  | 'baseline-writeback' // 解决差异后回写要素基准
  | 'amend-rolled-back' // 重算失败，记录恢复到动手前
  | 'recalc-rolled-back' // 重算失败，差异恢复到动手前

/** 一条版本链留痕事件 */
export interface ChainRevision {
  id: string
  /** 事件类型 */
  eventType: ChainActionType
  /** 关联实体类别 */
  entityType: ChainEntityType
  /** 关联实体 id（记录 / 差异 / 要素） */
  entityId: string
  /** 所属连戏要素（便于按要素追溯） */
  elementId?: string
  /** 操作原因 / 补记说明 */
  reason: string
  /** 操作人（记录人） */
  actor: string
  /** 变更前版本号 */
  fromVersion?: number
  /** 变更后版本号 */
  toVersion?: number
  /** 版本链分组：同一要素同一对记录的差异世代共享一个分组 */
  chainGroup?: string
  /** 被归档差异的继任差异 id */
  supersededBy?: string
  /** 动手前实体快照（JSON 字符串），重算失败时据此回滚 */
  snapshot?: string
  /** 备注 */
  note?: string
}

export const CHAIN_ACTION_LABELS: Record<ChainActionType, string> = {
  'record-amended': '现场记录补记 / 更正',
  'diff-invalidated': '差异标记待重算',
  'diff-regenerated': '差异重新生成',
  'diff-archived': '旧结论留档',
  'diff-resolved': '差异确认解决',
  'diff-reopened': '差异重新打开',
  'element-baseline-changed': '要素基准修改',
  'baseline-writeback': '基准回写',
  'amend-rolled-back': '记录已回滚',
  'recalc-rolled-back': '差异已回滚'
}

export const CHAIN_ENTITY_LABELS: Record<ChainEntityType, string> = {
  record: '现场记录',
  conflict: '连戏差异',
  element: '要素基准'
}
