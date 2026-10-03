/**
 * 连戏要素 store：维护要素清单、责任人与筛选条件。
 * 要素写入走乐观锁（revision）：后保存的窗口若读到旧版本会收到 VersionConflictError；
 * 初始状态（要素基准）变更会自动登记新一代基准版本（初始登记 / 手工修正）。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LocationQuery } from 'vue-router'
import type { Element } from '@/types/element'
import type { FilterModel } from '@/types/filter'
import {
  createElement as createElementRow,
  deleteElement as deleteElementRow,
  updateElement as updateElementRow,
  ROW_REVISION
} from '@/utils/db'
import { createId } from '@/utils/uuid'
import { queryToFilters } from '@/utils/query'

export const ELEMENT_FILTER_KEYS = ['categories', 'sceneIds']

export const useElementStore = defineStore('element', () => {
  const filters = ref<FilterModel>({ keyword: '', categories: [], sceneIds: [] })
  const selectedElementId = ref<string | null>(null)

  function setFilters(next: FilterModel): void {
    filters.value = next
  }

  function resetFilters(): void {
    filters.value = { keyword: '', categories: [], sceneIds: [] }
  }

  function applyQuery(query: LocationQuery): void {
    filters.value = queryToFilters(query, ELEMENT_FILTER_KEYS)
  }

  function select(id: string | null): void {
    selectedElementId.value = id
  }

  /** 新建要素：同步登记第 1 代要素基准 */
  async function createElement(payload: Omit<Element, 'id'>): Promise<string> {
    const now = Date.now()
    const id = createId('element')
    await createElementRow({ ...payload, id, revision: ROW_REVISION, createdAt: now, updatedAt: now })
    selectedElementId.value = id
    return id
  }

  /** 修改要素（乐观锁）：baseRevision 为打开编辑时读到的行版本；基准变化时自动留档新版本 */
  async function updateElement(
    id: string,
    patch: Partial<Element>,
    baseRevision: number
  ): Promise<{ baselineChanged: boolean }> {
    const result = await updateElementRow(id, patch, baseRevision)
    return { baselineChanged: result.baselineChanged }
  }

  /** 删除要素（乐观锁）：级联删除其记录、差异与版本链 */
  async function deleteElement(id: string, baseRevision: number): Promise<void> {
    await deleteElementRow(id, baseRevision)
    if (selectedElementId.value === id) selectedElementId.value = null
  }

  return { filters, selectedElementId, setFilters, resetFilters, applyQuery, select, createElement, updateElement, deleteElement }
})
