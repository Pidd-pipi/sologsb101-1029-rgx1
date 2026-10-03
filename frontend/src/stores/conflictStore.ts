/**
 * 连戏差异 store：维护差异列表、严重程度筛选、待重算留档与确认重算。
 * 版本链：差异按要素记代次（version + supersedes），旧结论标「待重算」留档、不参与统计；
 * 确认重算在事务内生成新一代差异，失败整体回滚。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LocationQuery } from 'vue-router'
import type { Conflict } from '@/types/conflict'
import type { FilterModel } from '@/types/filter'
import type { RecalcResult } from '@/utils/db'
import {
  putConflict,
  recalculateConflicts,
  removeConflict,
  reopenConflict,
  resolveConflict,
  ROW_REVISION
} from '@/utils/db'
import { createId } from '@/utils/uuid'
import { queryToFilters } from '@/utils/query'
import type { DiffCandidate } from '@/hooks/useContinuityDiff'

export const CONFLICT_FILTER_KEYS = ['severities', 'states']

export const useConflictStore = defineStore('conflict', () => {
  const filters = ref<FilterModel>({ keyword: '', severities: [], states: [] })
  /** 最近一次重算结果（供页面提示） */
  const lastRecalc = ref<RecalcResult | null>(null)

  function setFilters(next: FilterModel): void {
    filters.value = next
  }

  function resetFilters(): void {
    filters.value = { keyword: '', severities: [], states: [] }
  }

  function applyQuery(query: LocationQuery): void {
    filters.value = queryToFilters(query, CONFLICT_FILTER_KEYS)
  }

  /**
   * 确认重算：由比对候选生成新一代差异。
   * 事务内执行，记录版本不一致会抛 VersionConflictError 并整体回滚。
   */
  async function recalculate(candidates: DiffCandidate[]): Promise<RecalcResult> {
    const result = await recalculateConflicts(
      candidates.map((item) => ({
        elementId: item.elementId,
        recordIdA: item.a.id,
        recordIdB: item.b.id,
        diffDesc: item.desc,
        severity: item.severity,
        recordARevision: item.a.revision,
        recordBRevision: item.b.revision
      }))
    )
    lastRecalc.value = result
    return result
  }

  /** 手工登记一条差异（用于现场口头发现的偏差） */
  async function createManual(payload: Omit<Conflict, 'id' | 'resolvedNote' | 'resolvedAt'>): Promise<string> {
    const now = Date.now()
    const id = createId('conflict')
    await putConflict({
      ...payload,
      id,
      resolvedNote: '',
      resolvedAt: '',
      version: 1,
      supersedes: '',
      supersededBy: '',
      recalcReason: '',
      recalcDone: false,
      revision: ROW_REVISION,
      createdAt: now,
      updatedAt: now
    })
    return id
  }

  /** 解决差异（乐观锁）：写入留痕并回写要素初始状态，登记新一代要素基准 */
  async function resolve(
    id: string,
    note: string,
    expected?: { conflictRevision?: number; elementRevision?: number }
  ): Promise<void> {
    await resolveConflict(id, note, expected)
  }

  /** 重新打开差异（误判回退，乐观锁） */
  async function reopen(id: string, expectedRevision?: number): Promise<void> {
    await reopenConflict(id, expectedRevision)
  }

  async function remove(id: string): Promise<void> {
    await removeConflict(id)
  }

  return { filters, lastRecalc, setFilters, resetFilters, applyQuery, recalculate, createManual, resolve, reopen, remove }
})
