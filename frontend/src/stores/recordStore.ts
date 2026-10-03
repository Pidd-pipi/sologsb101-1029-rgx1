/**
 * 现场记录 store：维护现场记录与当前拍摄日上下文。
 * 补记 / 更正旧记录统一走版本链动作 amendRecord：相关差异先冻结为待重算，确认重算后再生成。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LocationQuery } from 'vue-router'
import type { ShootDay } from '@/types/shootDay'
import type { FilterModel } from '@/types/filter'
import type { RecordRow } from '@/utils/db'
import {
  nextShootOrder,
  putRecord,
  putShootDay,
  removeRecord,
  removeShootDay,
  updateShootDay as updateShootDayRow,
  INITIAL_VERSION,
  ROW_REVISION
} from '@/utils/db'
import { amendRecord } from '@/utils/versionChain'
import { createId } from '@/utils/uuid'
import { queryToFilters } from '@/utils/query'
import type { Record as ContinuityRecord } from '@/types/record'

export const RECORD_FILTER_KEYS = ['sceneIds', 'takes']

export interface UpdateRecordPayload {
  patch: Partial<ContinuityRecord>
  /** 编辑表单打开时读取到的版本号（乐观锁） */
  expectedVersion: number
  /** 补记 / 更正原因（写入版本链留痕） */
  reason: string
}

export const useRecordStore = defineStore('record', () => {
  const filters = ref<FilterModel>({ keyword: '', sceneIds: [], takes: [] })
  /** 当前选中的拍摄日（现场记录页的上下文） */
  const currentShootDayId = ref<string | null>(null)

  function setFilters(next: FilterModel): void {
    filters.value = next
  }

  function resetFilters(): void {
    filters.value = { keyword: '', sceneIds: [], takes: [] }
  }

  function applyQuery(query: LocationQuery): void {
    filters.value = queryToFilters(query, RECORD_FILTER_KEYS)
    if (typeof query.shootDayId === 'string' && query.shootDayId.length > 0) {
      currentShootDayId.value = query.shootDayId
    }
  }

  function selectShootDay(id: string | null): void {
    currentShootDayId.value = id
  }

  async function createShootDay(payload: Omit<ShootDay, 'id'>): Promise<string> {
    if (!payload.date) throw new Error('请选择拍摄日期')
    if (payload.sceneIds.length === 0) throw new Error('请至少选择一个当日场次')
    const now = Date.now()
    const id = createId('shootday')
    await putShootDay({ ...payload, id, revision: ROW_REVISION, createdAt: now, updatedAt: now })
    currentShootDayId.value = id
    return id
  }

  async function updateShootDay(id: string, patch: Partial<ShootDay>): Promise<void> {
    await updateShootDayRow(id, patch)
  }

  async function deleteShootDay(id: string): Promise<void> {
    await removeShootDay(id)
    if (currentShootDayId.value === id) currentShootDayId.value = null
  }

  async function createRecord(payload: Omit<ContinuityRecord, 'id'>): Promise<string> {
    if (!payload.shootDayId) throw new Error('请先选择拍摄日')
    if (!payload.elementId) throw new Error('请选择连戏要素')
    if (!payload.currentState.trim()) throw new Error('请填写当前状态')
    const now = Date.now()
    const id = createId('record')
    const row: RecordRow = {
      ...payload,
      id,
      version: INITIAL_VERSION,
      revision: ROW_REVISION,
      createdAt: now,
      updatedAt: now
    }
    await putRecord(row)
    return id
  }

  /**
   * 补记 / 更正旧记录：写新版本，相关差异冻结为待重算。
   * 版本冲突时抛 VersionConflictError（页面负责提示并载入最新版本）。
   */
  async function updateRecord(id: string, payload: UpdateRecordPayload): Promise<void> {
    await amendRecord({
      id,
      patch: payload.patch,
      expectedVersion: payload.expectedVersion,
      reason: payload.reason,
      actor: payload.patch.recordedBy?.trim() || '现场记录'
    })
  }

  async function deleteRecord(id: string): Promise<void> {
    await removeRecord(id)
  }

  /** 保留给后续扩展：拍摄顺序号 */
  async function peekNextOrder(): Promise<number> {
    return nextShootOrder()
  }

  return {
    filters,
    currentShootDayId,
    setFilters,
    resetFilters,
    applyQuery,
    selectShootDay,
    createShootDay,
    updateShootDay,
    deleteShootDay,
    createRecord,
    updateRecord,
    deleteRecord,
    peekNextOrder
  }
})
