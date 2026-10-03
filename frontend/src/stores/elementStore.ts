/**
 * 连戏要素 store：维护要素清单、责任人与筛选条件。
 * 修改要素（尤其是基准字段）统一走版本链动作 amendElement：
 * 基准变化时相关差异冻结为待重算，并做乐观版本号校验防跨标签页覆盖。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LocationQuery } from 'vue-router'
import type { Element } from '@/types/element'
import type { FilterModel } from '@/types/filter'
import { putElement, removeElement, ROW_REVISION, INITIAL_VERSION } from '@/utils/db'
import { amendElement } from '@/utils/versionChain'
import { createId } from '@/utils/uuid'
import { queryToFilters } from '@/utils/query'

export const ELEMENT_FILTER_KEYS = ['categories', 'sceneIds']

export interface UpdateElementPayload {
  patch: Partial<Element>
  /** 编辑表单打开时读取到的版本号（乐观锁） */
  expectedVersion: number
  /** 修改原因（写入版本链留痕） */
  reason?: string
}

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

  async function createElement(payload: Omit<Element, 'id'>): Promise<string> {
    const now = Date.now()
    const id = createId('element')
    await putElement({ ...payload, id, version: INITIAL_VERSION, revision: ROW_REVISION, createdAt: now, updatedAt: now })
    selectedElementId.value = id
    return id
  }

  /**
   * 修改要素：乐观版本号校验；基准字段变化会冻结相关差异为待重算。
   * 版本冲突时抛 VersionConflictError。
   */
  async function updateElement(id: string, payload: UpdateElementPayload): Promise<void> {
    await amendElement({
      id,
      patch: payload.patch,
      expectedVersion: payload.expectedVersion,
      reason: payload.reason ?? '连戏要素被修改',
      actor: payload.patch.owner?.trim() || '要素登记'
    })
  }

  async function deleteElement(id: string): Promise<void> {
    await removeElement(id)
    if (selectedElementId.value === id) selectedElementId.value = null
  }

  return { filters, selectedElementId, setFilters, resetFilters, applyQuery, select, createElement, updateElement, deleteElement }
})
