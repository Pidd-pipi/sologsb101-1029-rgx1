/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名 gbcontinuity-db，数据结构版本号 version(2) 与 upgrade() 迁移逻辑
 * - 场次 / 连戏要素 / 拍摄日 / 现场记录 / 连戏差异 / 版本链留痕 六张表分表存储
 * - 现场记录与要素基准带 version 乐观版本号；差异带版本链世代字段
 * - 首次打开自动播种互相引用的演示数据（含未解决冲突），保证每个页面打开都有内容
 */
import Dexie, { type Table } from 'dexie'
import { toRaw } from 'vue'
import type { Scene } from '../types/scene'
import type { Element } from '../types/element'
import type { ShootDay } from '../types/shootDay'
import type { Record as ContinuityRecord } from '../types/record'
import type { Conflict } from '../types/conflict'
import type { ChainRevision } from '../types/chainRevision'
import { nowIso } from './uuid'
import { seedDatabase } from './seed'

/** 数据库名 */
export const DB_NAME = 'gbcontinuity-db'

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 2

/** 行结构修订号 */
export const ROW_REVISION = 2

/** 初始乐观版本号 */
export const INITIAL_VERSION = 1

/** 带时间戳与修订号的持久化实体 */
export interface Revisioned {
  revision: number
  createdAt: number
  updatedAt: number
}

/** 带乐观版本号的实体（现场记录、要素基准） */
export interface Versioned {
  version: number
}

export type SceneRow = Scene & Revisioned
export type ElementRow = Element & Revisioned & Versioned
export type ShootDayRow = ShootDay & Revisioned
export type RecordRow = ContinuityRecord & Revisioned & Versioned
export type ConflictRow = Conflict & Revisioned
export type ChainRevisionRow = ChainRevision & Revisioned

/**
 * 深度剥掉 Vue 响应式代理（Proxy），得到可被 IndexedDB 结构化克隆的普通对象。
 * 页面里 `v-model` 绑定的数组字段（如 `ShootDay.sceneIds`）是 Vue 的 Proxy 数组，
 * 直接交给 Dexie 会抛 `DataCloneError: [object Object] could not be cloned`，
 * 表现为“保存按钮点了没反应、列表不增加、刷新后丢失”。所有写库入口都必须先过这一层。
 */
export function toPlainRow<T>(value: T): T {
  const raw = toRaw(value) as unknown
  if (Array.isArray(raw)) return raw.map((item) => toPlainRow(item)) as unknown as T
  if (raw !== null && typeof raw === 'object') {
    const proto = Object.getPrototypeOf(raw)
    // 只深拷贝普通对象/数组，Date、Map 等结构化克隆本身支持的对象原样返回
    if (proto === Object.prototype || proto === null) {
      const plain: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(raw)) plain[key] = toPlainRow(item)
      return plain as T
    }
  }
  return raw as T
}

/** 差异版本链分组键：同一要素同一对记录的各代差异串联到同一分组 */
export function conflictChainGroup(elementId: string, recordIdA: string, recordIdB: string): string {
  return `grp:${elementId}:${recordIdA}:${recordIdB}`
}

class GbContinuityDatabase extends Dexie {
  scenes!: Table<SceneRow, string>
  elements!: Table<ElementRow, string>
  shootDays!: Table<ShootDayRow, string>
  records!: Table<RecordRow, string>
  conflicts!: Table<ConflictRow, string>
  chainRevisions!: Table<ChainRevisionRow, string>

  constructor() {
    super(DB_NAME)

    // v1：初版五表（保留以升级到 v2）
    this.version(1).stores({
      scenes: 'id, sceneNo, place, timeOfDay, shootOrder, state, updatedAt',
      elements: 'id, sceneId, category, name, owner, critical, updatedAt',
      shootDays: 'id, date, director, scripty, updatedAt',
      records: 'id, shootDayId, elementId, sceneId, takeNo, updatedAt',
      conflicts: 'id, elementId, recordIdA, recordIdB, severity, state, updatedAt'
    })

    // v2：记录 / 要素补 version；差异补版本链世代字段；新增版本链留痕表
    this.version(2)
      .stores({
        scenes: 'id, sceneNo, place, timeOfDay, shootOrder, state, updatedAt',
        elements: 'id, sceneId, category, name, owner, critical, updatedAt, version',
        shootDays: 'id, date, director, scripty, updatedAt',
        records: 'id, shootDayId, elementId, sceneId, takeNo, updatedAt, version',
        conflicts: 'id, elementId, recordIdA, recordIdB, severity, state, updatedAt, chainGroup',
        chainRevisions: 'id, eventType, entityType, entityId, elementId, chainGroup, createdAt'
      })
      .upgrade(async (tx) => {
        // v1 → v2：为历史行补齐乐观版本号与差异版本链世代字段；新建库各表为空，迁移天然幂等
        await tx
          .table('records')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.version !== 'number') row.version = INITIAL_VERSION
          })
        await tx
          .table('elements')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.version !== 'number') row.version = INITIAL_VERSION
          })
        await tx
          .table('conflicts')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            const elementId = typeof row.elementId === 'string' ? row.elementId : ''
            const recordIdA = typeof row.recordIdA === 'string' ? row.recordIdA : ''
            const recordIdB = typeof row.recordIdB === 'string' ? row.recordIdB : ''
            if (typeof row.chainGroup !== 'string' || !row.chainGroup) {
              row.chainGroup = conflictChainGroup(elementId, recordIdA, recordIdB)
            }
            if (typeof row.generation !== 'number') row.generation = 1
            if (typeof row.recordAVersion !== 'number') row.recordAVersion = 0
            if (typeof row.recordBVersion !== 'number') row.recordBVersion = 0
            if (typeof row.baselineVersion !== 'number') row.baselineVersion = 0
            if (typeof row.supersededBy !== 'string') row.supersededBy = ''
            if (typeof row.preRecalcSnapshot !== 'string') row.preRecalcSnapshot = ''
          })
      })
  }
}

export const db = new GbContinuityDatabase()

/** 打开数据库：首次使用时灌入演示数据（幂等：表非空不播） */
export async function initDatabase(): Promise<void> {
  await db.open()
  if ((await db.scenes.count()) === 0) {
    await seedDatabase()
  }
}

/* ------------------------------ 场次 ------------------------------ */

export async function listScenes(): Promise<SceneRow[]> {
  const rows = await db.scenes.toArray()
  return rows.sort((a, b) => a.shootOrder - b.shootOrder)
}

export async function putScene(row: SceneRow): Promise<void> {
  await db.scenes.put(toPlainRow(row))
}

export async function updateScene(id: string, patch: Partial<Scene>): Promise<void> {
  await db.scenes.update(id, toPlainRow({ ...patch, updatedAt: Date.now() }) as never)
}

/** 拖拽调序后按新顺序批量写回 shootOrder（从 1 开始自动重编号） */
export async function reorderScenes(orderedIds: string[]): Promise<void> {
  await db.transaction('rw', db.scenes, async () => {
    for (let index = 0; index < orderedIds.length; index += 1) {
      await db.scenes.update(orderedIds[index], { shootOrder: index + 1, updatedAt: Date.now() } as never)
    }
  })
}

/** 下一个可用拍摄顺序号 */
export async function nextShootOrder(): Promise<number> {
  const rows = await db.scenes.toArray()
  return rows.reduce((max, row) => Math.max(max, row.shootOrder), 0) + 1
}

/** 删除场次：级联删除其下要素、现场记录与差异（版本链留痕保留以备审计） */
export async function removeScene(id: string): Promise<void> {
  await db.transaction('rw', [db.scenes, db.elements, db.records, db.conflicts], async () => {
    const elements = await db.elements.where('sceneId').equals(id).toArray()
    const elementIds = elements.map((item) => item.id)
    const records = await db.records.where('sceneId').equals(id).toArray()
    const recordIds = records.map((item) => item.id)
    if (elementIds.length > 0) {
      await db.conflicts.where('elementId').anyOf(elementIds).delete()
    }
    if (recordIds.length > 0) {
      await db.conflicts.filter((item) => recordIds.includes(item.recordIdA) || recordIds.includes(item.recordIdB)).delete()
    }
    await db.records.where('sceneId').equals(id).delete()
    await db.elements.where('sceneId').equals(id).delete()
    await db.shootDays.toCollection().modify((day) => {
      if (day.sceneIds.includes(id)) {
        day.sceneIds = day.sceneIds.filter((sceneId) => sceneId !== id)
        day.updatedAt = Date.now()
      }
    })
    await db.scenes.delete(id)
  })
}

/* ---------------------------- 连戏要素 ---------------------------- */

export async function listElements(): Promise<ElementRow[]> {
  const rows = await db.elements.toArray()
  return rows.sort((a, b) => a.category.localeCompare(b.category, 'zh-Hans-CN') || a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

export async function putElement(row: ElementRow): Promise<void> {
  await db.elements.put(toPlainRow(row))
}

export async function updateElement(id: string, patch: Partial<Element & Versioned>): Promise<void> {
  await db.elements.update(id, toPlainRow({ ...patch, updatedAt: Date.now() }) as never)
}

export async function removeElement(id: string): Promise<void> {
  await db.transaction('rw', [db.elements, db.records, db.conflicts], async () => {
    await db.conflicts.where('elementId').equals(id).delete()
    await db.records.where('elementId').equals(id).delete()
    await db.elements.delete(id)
  })
}

/* ------------------------------ 拍摄日 ------------------------------ */

export async function listShootDays(): Promise<ShootDayRow[]> {
  const rows = await db.shootDays.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function putShootDay(row: ShootDayRow): Promise<void> {
  await db.shootDays.put(toPlainRow(row))
}

export async function updateShootDay(id: string, patch: Partial<ShootDay>): Promise<void> {
  await db.shootDays.update(id, toPlainRow({ ...patch, updatedAt: Date.now() }) as never)
}

export async function removeShootDay(id: string): Promise<void> {
  await db.transaction('rw', [db.shootDays, db.records, db.conflicts], async () => {
    const records = await db.records.where('shootDayId').equals(id).toArray()
    const recordIds = records.map((item) => item.id)
    if (recordIds.length > 0) {
      await db.conflicts.filter((item) => recordIds.includes(item.recordIdA) || recordIds.includes(item.recordIdB)).delete()
    }
    await db.records.where('shootDayId').equals(id).delete()
    await db.shootDays.delete(id)
  })
}

/* ---------------------------- 现场记录 ---------------------------- */

export async function listRecords(): Promise<RecordRow[]> {
  const rows = await db.records.toArray()
  return rows.sort((a, b) => a.takeNo.localeCompare(b.takeNo, 'zh-Hans-CN'))
}

export async function putRecord(row: RecordRow): Promise<void> {
  await db.records.put(toPlainRow(row))
}

export async function updateRecord(id: string, patch: Partial<ContinuityRecord & Versioned>): Promise<void> {
  await db.records.update(id, toPlainRow({ ...patch, updatedAt: Date.now() }) as never)
}

export async function removeRecord(id: string): Promise<void> {
  await db.transaction('rw', [db.records, db.conflicts], async () => {
    await db.conflicts.filter((item) => item.recordIdA === id || item.recordIdB === id).delete()
    await db.records.delete(id)
  })
}

/* ---------------------------- 连戏差异 ---------------------------- */

export async function listConflicts(): Promise<ConflictRow[]> {
  return db.conflicts.toArray()
}

export async function putConflict(row: ConflictRow): Promise<void> {
  await db.conflicts.put(toPlainRow(row))
}

export async function removeConflict(id: string): Promise<void> {
  await db.conflicts.delete(id)
}

/* ---------------------------- 版本链留痕 ---------------------------- */

export async function listChainRevisions(): Promise<ChainRevisionRow[]> {
  const rows = await db.chainRevisions.toArray()
  return rows.sort((a, b) => b.createdAt - a.createdAt)
}

export async function putChainRevision(row: ChainRevisionRow): Promise<void> {
  await db.chainRevisions.put(toPlainRow(row))
}

/* --------------------------- 整库导入导出 --------------------------- */

export interface DatabaseSnapshot {
  name: string
  schemaVersion: number
  exportedAt: string
  scenes: Scene[]
  elements: Array<Element & Partial<Versioned>>
  shootDays: ShootDay[]
  records: Array<ContinuityRecord & Partial<Versioned>>
  conflicts: Array<Conflict & Partial<Versioned>>
  chainRevisions: ChainRevision[]
}

function stripRow<T extends Revisioned>(row: T): Omit<T, keyof Revisioned> {
  const copy = { ...row } as Record<string, unknown>
  delete copy.revision
  delete copy.createdAt
  delete copy.updatedAt
  return copy as Omit<T, keyof Revisioned>
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [scenes, elements, shootDays, records, conflicts, chainRevisions] = await Promise.all([
    db.scenes.toArray(),
    db.elements.toArray(),
    db.shootDays.toArray(),
    db.records.toArray(),
    db.conflicts.toArray(),
    db.chainRevisions.toArray()
  ])
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    scenes: scenes.map(stripRow),
    elements: elements.map(stripRow),
    shootDays: shootDays.map(stripRow),
    records: records.map(stripRow),
    conflicts: conflicts.map(stripRow),
    chainRevisions: chainRevisions.map(stripRow)
  }
}

function stamp<T>(row: T): T & Revisioned {
  const now = Date.now()
  return { ...row, revision: ROW_REVISION, createdAt: now, updatedAt: now }
}

/** 为导入的旧备份补齐 v2 版本链字段，避免缺字段行参与比对时出错 */
function normalizeImported(
  snapshot: DatabaseSnapshot
): {
  elements: ElementRow[]
  records: RecordRow[]
  conflicts: ConflictRow[]
  chainRevisions: ChainRevisionRow[]
} {
  const elements = snapshot.elements.map((item) => ({
    ...item,
    version: typeof item.version === 'number' ? item.version : INITIAL_VERSION
  })) as ElementRow[]
  const records = snapshot.records.map((item) => ({
    ...item,
    version: typeof item.version === 'number' ? item.version : INITIAL_VERSION
  })) as RecordRow[]
  const conflicts = snapshot.conflicts.map((item) => ({
    ...item,
    chainGroup:
      typeof item.chainGroup === 'string' && item.chainGroup
        ? item.chainGroup
        : conflictChainGroup(item.elementId, item.recordIdA, item.recordIdB),
    generation: typeof item.generation === 'number' ? item.generation : 1,
    recordAVersion: typeof item.recordAVersion === 'number' ? item.recordAVersion : 0,
    recordBVersion: typeof item.recordBVersion === 'number' ? item.recordBVersion : 0,
    baselineVersion: typeof item.baselineVersion === 'number' ? item.baselineVersion : 0,
    supersededBy: typeof item.supersededBy === 'string' ? item.supersededBy : '',
    preRecalcSnapshot: typeof item.preRecalcSnapshot === 'string' ? item.preRecalcSnapshot : ''
  })) as ConflictRow[]
  const chainRevisions = (snapshot.chainRevisions ?? []) as ChainRevisionRow[]
  return { elements, records, conflicts, chainRevisions }
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  const normalized = normalizeImported(snapshot)
  await db.transaction(
    'rw',
    [db.scenes, db.elements, db.shootDays, db.records, db.conflicts, db.chainRevisions],
    async () => {
      await Promise.all([
        db.scenes.clear(),
        db.elements.clear(),
        db.shootDays.clear(),
        db.records.clear(),
        db.conflicts.clear(),
        db.chainRevisions.clear()
      ])
      await db.scenes.bulkPut(snapshot.scenes.map(stamp))
      await db.elements.bulkPut(normalized.elements.map(stamp))
      await db.shootDays.bulkPut(snapshot.shootDays.map(stamp))
      await db.records.bulkPut(normalized.records.map(stamp))
      await db.conflicts.bulkPut(normalized.conflicts.map(stamp))
      await db.chainRevisions.bulkPut(normalized.chainRevisions.map(stamp))
    }
  )
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.scenes, db.elements, db.shootDays, db.records, db.conflicts, db.chainRevisions],
    async () => {
      await Promise.all([
        db.scenes.clear(),
        db.elements.clear(),
        db.shootDays.clear(),
        db.records.clear(),
        db.conflicts.clear(),
        db.chainRevisions.clear()
      ])
    }
  )
  await seedDatabase()
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [scenes, elements, shootDays, records, conflicts, chainRevisions] = await Promise.all([
    db.scenes.count(),
    db.elements.count(),
    db.shootDays.count(),
    db.records.count(),
    db.conflicts.count(),
    db.chainRevisions.count()
  ])
  return { scenes, elements, shootDays, records, conflicts, chainRevisions }
}
