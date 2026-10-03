/**
 * 连戏差异 store：差异版本链生命周期（待确认 → 待重算 → 已留档 / 新一代）与严重程度筛选。
 * - 首次比对：generateInitial 生成待确认差异；
 * - 旧记录 / 基准改动后相关差异由版本链动作自动冻结为待重算；
 * - confirmRecalc 确认重算：旧结论留档（不参与统计），生成新一代，失败整体回滚；
 * - 解决差异回写要素基准；所有动作均带乐观版本号校验。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LocationQuery } from 'vue-router'
import type { FilterModel } from '@/types/filter'
import type { ConflictRow, ElementRow } from '@/utils/db'
import { removeConflict } from '@/utils/db'
import {
  generateInitialConflicts,
  listPendingElementIds,
  recalculateElement,
  reopenConflictGuarded,
  resolveConflictGuarded,
  type RecalcResult
} from '@/utils/versionChain'
import { queryToFilters } from '@/utils/query'

export const CONFLICT_FILTER_KEYS = ['severities', 'states']

export interface ResolvePayload {
  note: string
  actor: string
  /** 打开解决弹窗时的要素基准版本（乐观锁） */
  expectedBaselineVersion?: number
}

export const useConflictStore = defineStore('conflict', () => {
  const filters = ref<FilterModel>({ keyword: '', severities: [], states: [] })
  const lastGenerated = ref<number>(0)

  function setFilters(next: FilterModel): void {
    filters.value = next
  }

  function resetFilters(): void {
    filters.value = { keyword: '', severities: [], states: [] }
  }

  function applyQuery(query: LocationQuery): void {
    filters.value = queryToFilters(query, CONFLICT_FILTER_KEYS)
  }

  /** 首次「重新比对」：为全部要素生成待确认差异（已有同分组结论的不重复生成） */
  async function generateInitial(actor = '差异比对'): Promise<number> {
    const created = await generateInitialConflicts(actor)
    lastGenerated.value = created
    return created
  }

  /** 确认重算单个要素：旧结论留档、生成新一代差异；失败抛 RecalculationError（已回滚） */
  async function confirmRecalc(elementId: string, actor = '差异比对'): Promise<RecalcResult> {
    return recalculateElement(elementId, actor)
  }

  /** 确认重算全部待重算要素（逐要素事务，首个失败即停） */
  async function confirmRecalcAll(actor = '差异比对'): Promise<{ confirmed: number; archived: number; created: number }> {
    const ids = await listPendingElementIds()
    let archived = 0
    let created = 0
    for (const id of ids) {
      const result = await recalculateElement(id, actor)
      archived += result.archived
      created += result.created
    }
    return { confirmed: ids.length, archived, created }
  }

  /** 解决差异：写留痕并回写要素基准（带基准版本乐观锁） */
  async function resolve(id: string, payload: ResolvePayload): Promise<void> {
    await resolveConflictGuarded({ id, note: payload.note, actor: payload.actor, expectedBaselineVersion: payload.expectedBaselineVersion })
  }

  async function reopen(id: string, actor = '差异比对'): Promise<void> {
    await reopenConflictGuarded(id, actor)
  }

  async function remove(id: string): Promise<void> {
    await removeConflict(id)
  }

  /** 解决前再次确认要素基准版本未被其他标签页改动（页面弹窗打开时读一次） */
  function baselineVersionOf(elements: ElementRow[], conflict: ConflictRow): number {
    return elements.find((item) => item.id === conflict.elementId)?.version ?? conflict.baselineVersion
  }

  return {
    filters,
    lastGenerated,
    setFilters,
    resetFilters,
    applyQuery,
    generateInitial,
    confirmRecalc,
    confirmRecalcAll,
    resolve,
    reopen,
    remove,
    baselineVersionOf
  }
})
