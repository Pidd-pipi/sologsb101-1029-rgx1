/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名 gbcontinuity-db，数据结构版本号 version(2) 与 upgrade() 迁移逻辑
 * - 场次 / 连戏要素 / 拍摄日 / 现场记录 / 连戏差异 / 现场记录版本 / 要素基准版本 分表存储
 * - 版本链：现场记录修改前快照入 recordVersions；差异代次靠 version + supersedes 串联；
 *   要素基准变更入 baselineVersions。旧结论留档（待重算）不参与统计。
 * - 乐观锁：每行 revision 每次写入 +1，写入前校验，版本不一致抛 VersionConflictError。
 * - 首次打开自动播种互相引用的演示数据（含未解决冲突），保证每个页面打开都有内容
 */
import Dexie, { type Table } from 'dexie'
import { toRaw } from 'vue'
import type { Scene } from '../types/scene'
import type { Element } from '../types/element'
import type { ShootDay } from '../types/shootDay'
import type { Record as ContinuityRecord } from '../types/record'
import type { Conflict, ConflictSeverity } from '../types/conflict'
import { ARCHIVED_CONFLICT_STATE } from '../types/conflict'
export { ARCHIVED_CONFLICT_STATE }
import type { RecordVersion } from '../types/recordVersion'
import { snapshotRecord } from '../types/recordVersion'
import type { BaselineVersion } from '../types/baselineVersion'
import { createBaselineVersion } from '../types/baselineVersion'
import { createId, nowIso } from './uuid'
import { seedDatabase } from './seed'

/** 数据库名 */
export const DB_NAME = 'gbcontinuity-db'

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 2

/** 行结构修订号 */
export const ROW_REVISION = 1

/** 带时间戳与修订号的持久化实体 */
export interface Revisioned {
  revision: number
  createdAt: number
  updatedAt: number
}

export type SceneRow = Scene & Revisioned
export type ElementRow = Element & Revisioned
export type ShootDayRow = ShootDay & Revisioned
export type RecordRow = ContinuityRecord & Revisioned
export type ConflictRow = Conflict & Revisioned
export type RecordVersionRow = RecordVersion
export type BaselineVersionRow = BaselineVersion

/**
 * 乐观锁版本冲突：两个窗口同时改同一行，后保存的一方读到的 revision 已过期。
 * 页面捕获后提示「已被其他窗口修改，请刷新后重试」，不得覆盖对方刚写入的状态。
 */
export class VersionConflictError extends Error {
  constructor(public readonly entityLabel: string) {
    super(`版本冲突：${entityLabel}已被其他窗口修改，请刷新后重试，勿覆盖对方刚写入的状态`)
    this.name = 'VersionConflictError'
  }
}

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

class GbContinuityDatabase extends Dexie {
  scenes!: Table<SceneRow, string>
  elements!: Table<ElementRow, string>
  shootDays!: Table<ShootDayRow, string>
  records!: Table<RecordRow, string>
  conflicts!: Table<ConflictRow, string>
  recordVersions!: Table<RecordVersionRow, string>
  baselineVersions!: Table<BaselineVersionRow, string>

  constructor() {
    super(DB_NAME)

    this.version(1).stores({
      scenes: 'id, sceneNo, place, timeOfDay, shootOrder, state, updatedAt',
      elements: 'id, sceneId, category, name, owner, critical, updatedAt',
      shootDays: 'id, date, director, scripty, updatedAt',
      records: 'id, shootDayId, elementId, sceneId, takeNo, updatedAt',
      conflicts: 'id, elementId, recordIdA, recordIdB, severity, state, updatedAt'
    })

    this.version(2)
      .stores({
        scenes: 'id, sceneNo, place, timeOfDay, shootOrder, state, updatedAt',
        elements: 'id, sceneId, category, name, owner, critical, updatedAt',
        shootDays: 'id, date, director, scripty, updatedAt',
        records: 'id, shootDayId, elementId, sceneId, takeNo, updatedAt',
        conflicts: 'id, elementId, recordIdA, recordIdB, severity, state, version, updatedAt',
        recordVersions: 'id, recordId, elementId, createdAt',
        baselineVersions: 'id, elementId, version, source, createdAt'
      })
      .upgrade(async (tx) => {
        // 结构迁移：为历史行补齐行修订号与时间戳；新建库时各表为空，迁移天然幂等
        const tableNames = ['scenes', 'elements', 'shootDays', 'records', 'conflicts']
        for (const name of tableNames) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              row.revision = ROW_REVISION
              if (typeof row.createdAt !== 'number') row.createdAt = Date.now()
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt
            })
        }
        // 差异版本链迁移：历史差异一律视为第 1 代，尚无取代关系与留档原因
        await tx.table('conflicts').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.version !== 'number') row.version = 1
          if (typeof row.supersedes !== 'string') row.supersedes = ''
          if (typeof row.supersededBy !== 'string') row.supersededBy = ''
          if (typeof row.recalcReason !== 'string') row.recalcReason = ''
          if (typeof row.recalcDone !== 'boolean') row.recalcDone = false
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

/** 删除场次：级联删除其下要素、现场记录；相关差异标记留档待重算 */
export async function removeScene(id: string): Promise<void> {
  await db.transaction('rw', [db.scenes, db.elements, db.records, db.conflicts, db.baselineVersions, db.recordVersions], async () => {
    const elements = await db.elements.where('sceneId').equals(id).toArray()
    const elementIds = elements.map((item) => item.id)
    const records = await db.records.where('sceneId').equals(id).toArray()
    const recordIds = records.map((item) => item.id)
    const now = Date.now()
    if (elementIds.length > 0) {
      await markConflictsPendingWhere(
        (item) => elementIds.includes(item.elementId),
        '场次删除，旧结论留档待重算',
        now
      )
      await db.baselineVersions.where('elementId').anyOf(elementIds).delete()
      await db.recordVersions.where('elementId').anyOf(elementIds).delete()
    }
    if (recordIds.length > 0) {
      await markConflictsPendingWhere(
        (item) => recordIds.includes(item.recordIdA) || recordIds.includes(item.recordIdB),
        '场次删除，旧结论留档待重算',
        now
      )
    }
    await db.records.where('sceneId').equals(id).delete()
    await db.elements.where('sceneId').equals(id).delete()
    await db.shootDays.toCollection().modify((day) => {
      if (day.sceneIds.includes(id)) {
        day.sceneIds = day.sceneIds.filter((sceneId) => sceneId !== id)
        day.updatedAt = now
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

export async function listBaselineVersions(): Promise<BaselineVersionRow[]> {
  const rows = await db.baselineVersions.toArray()
  return rows.sort((a, b) => b.createdAt - a.createdAt || b.version - a.version)
}

/** 新建要素：同步登记第 1 代要素基准（初始登记） */
export async function createElement(row: ElementRow): Promise<{ element: ElementRow }> {
  await db.transaction('rw', [db.elements, db.baselineVersions], async () => {
    await db.elements.add(toPlainRow(row))
    await db.baselineVersions.put(
      toPlainRow(createBaselineVersion(row.id, 1, row.initialState, '初始登记', { id: createId('baselinever') }, Date.now()))
    )
  })
  return { element: row }
}

/**
 * 更新要素（乐观锁）：revision 不一致抛 VersionConflictError；
 * 初始状态（要素基准）发生变化时追加新一代基准版本（手工修正）。
 */
export async function updateElement(
  id: string,
  patch: Partial<Element>,
  baseRevision: number
): Promise<{ element: ElementRow; baselineChanged: boolean }> {
  return db.transaction('rw', [db.elements, db.baselineVersions], async () => {
    const current = await db.elements.get(id)
    if (!current) throw new Error('连戏要素不存在或已删除')
    if (current.revision !== baseRevision) throw new VersionConflictError('连戏要素')
    const now = Date.now()
    let baselineChanged = false
    if (patch.initialState !== undefined && patch.initialState !== current.initialState) {
      const versions = await db.baselineVersions.where('elementId').equals(id).toArray()
      const nextVersion = versions.reduce((max, item) => Math.max(max, item.version), 0) + 1
      await db.baselineVersions.put(
        toPlainRow(
          createBaselineVersion(
            id,
            nextVersion,
            patch.initialState,
            '手工修正',
            { id: createId('baselinever'), note: '手工修正要素基准' },
            now
          )
        )
      )
      baselineChanged = true
    }
    const updated: ElementRow = { ...current, ...patch, revision: current.revision + 1, updatedAt: now }
    await db.elements.put(toPlainRow(updated))
    return { element: updated, baselineChanged }
  })
}

/** 删除要素（乐观锁）：级联删除其记录、差异与两条版本链 */
export async function deleteElement(id: string, baseRevision: number): Promise<void> {
  await db.transaction('rw', [db.elements, db.records, db.conflicts, db.baselineVersions, db.recordVersions], async () => {
    const current = await db.elements.get(id)
    if (!current) throw new Error('连戏要素不存在或已删除')
    if (current.revision !== baseRevision) throw new VersionConflictError('连戏要素')
    await db.conflicts.where('elementId').equals(id).delete()
    await db.records.where('elementId').equals(id).delete()
    await db.baselineVersions.where('elementId').equals(id).delete()
    await db.recordVersions.where('elementId').equals(id).delete()
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

/** 删除拍摄日：当日记录与相关差异标记留档待重算，再删记录与拍摄日 */
export async function removeShootDay(id: string): Promise<void> {
  await db.transaction('rw', [db.shootDays, db.records, db.conflicts, db.recordVersions], async () => {
    const records = await db.records.where('shootDayId').equals(id).toArray()
    const recordIds = records.map((item) => item.id)
    const now = Date.now()
    if (recordIds.length > 0) {
      await markConflictsPendingWhere(
        (item) => recordIds.includes(item.recordIdA) || recordIds.includes(item.recordIdB),
        '拍摄日删除，旧结论留档待重算',
        now
      )
      await db.recordVersions.where('recordId').anyOf(recordIds).delete()
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

export async function listRecordVersions(): Promise<RecordVersionRow[]> {
  const rows = await db.recordVersions.toArray()
  return rows.sort((a, b) => b.createdAt - a.createdAt || b.revision - a.revision)
}

export interface RecordWriteResult {
  /** 写入后的记录行 */
  record: RecordRow
  /** 被标记为待重算的差异 id */
  affectedConflictIds: string[]
}

/** 新建现场记录：同要素相关差异标记留档待重算（新增镜次可能改变最近两次配对） */
export async function createRecord(row: RecordRow): Promise<RecordWriteResult> {
  return db.transaction('rw', [db.records, db.conflicts], async () => {
    await db.records.add(toPlainRow(row))
    const affectedConflictIds = await markElementConflictsPending(
      row.elementId,
      `新增现场记录（镜次 ${row.takeNo}），待重算`
    )
    return { record: row, affectedConflictIds }
  })
}

/** 本次 patch 改了哪些字段，用于生成快照说明 */
function describeRecordPatch(patch: Partial<ContinuityRecord>): string {
  const labels: Array<[keyof ContinuityRecord, string]> = [
    ['shootDayId', '拍摄日'],
    ['elementId', '连戏要素'],
    ['sceneId', '场次'],
    ['takeNo', '镜次'],
    ['currentState', '当前状态'],
    ['photoNote', '照片说明'],
    ['recordedBy', '记录人']
  ]
  const changed = labels.filter(([key]) => key in patch).map(([, label]) => label)
  return changed.length > 0 ? `更正${changed.join('、')}` : '更正记录'
}

/**
 * 修改现场记录（乐观锁）：
 * 1) 校验 revision，不一致抛 VersionConflictError，整体回滚；
 * 2) 修改前快照入 recordVersions（现场记录版本链）；
 * 3) 同要素相关差异标记「待重算」，旧结论留档不参与统计。
 */
export async function updateRecord(
  id: string,
  patch: Partial<ContinuityRecord>,
  baseRevision: number
): Promise<RecordWriteResult> {
  return db.transaction('rw', [db.records, db.conflicts, db.recordVersions], async () => {
    const current = await db.records.get(id)
    if (!current) throw new Error('现场记录不存在或已删除')
    if (current.revision !== baseRevision) throw new VersionConflictError('现场记录')
    const now = Date.now()
    const changeNote = describeRecordPatch(patch)
    await db.recordVersions.put(
      toPlainRow(snapshotRecord(current, createId('recver'), changeNote, now))
    )
    const updated: RecordRow = { ...current, ...patch, revision: current.revision + 1, updatedAt: now }
    await db.records.put(toPlainRow(updated))
    const affectedConflictIds = await markElementConflictsPending(
      current.elementId,
      `记录镜次 ${current.takeNo} 已修改（${changeNote}），待重算`,
      now
    )
    // 若记录改挂到其他要素，新要素的最近两次配对也可能变化，一并标记
    if (patch.elementId && patch.elementId !== current.elementId) {
      const affectedNew = await markElementConflictsPending(
        patch.elementId,
        `记录镜次 ${current.takeNo} 已修改并转入本要素，待重算`,
        now
      )
      affectedConflictIds.push(...affectedNew)
    }
    return { record: updated, affectedConflictIds }
  })
}

/** 删除现场记录（乐观锁）：删除前快照留档，引用它的差异标记待重算 */
export async function deleteRecord(id: string, baseRevision: number): Promise<{ affectedConflictIds: string[] }> {
  return db.transaction('rw', [db.records, db.conflicts, db.recordVersions], async () => {
    const current = await db.records.get(id)
    if (!current) throw new Error('现场记录不存在或已删除')
    if (current.revision !== baseRevision) throw new VersionConflictError('现场记录')
    const now = Date.now()
    await db.recordVersions.put(toPlainRow(snapshotRecord(current, createId('recver'), '删除前快照', now)))
    const affectedConflictIds = await markConflictsPendingWhere(
      (item) => item.recordIdA === id || item.recordIdB === id,
      '记录已删除，待按剩余记录重算',
      now
    )
    await db.records.delete(id)
    return { affectedConflictIds }
  })
}

/* ---------------------------- 连戏差异 ---------------------------- */

export async function listConflicts(): Promise<ConflictRow[]> {
  return db.conflicts.toArray()
}

export async function putConflict(row: ConflictRow): Promise<void> {
  await db.conflicts.put(toPlainRow(row))
}

/** 把要素的当前结论差异标记为待重算（已留档的不动），返回受影响差异 id */
async function markElementConflictsPending(elementId: string, reason: string, now: number = Date.now()): Promise<string[]> {
  return markConflictsPendingWhere((item) => item.elementId === elementId, reason, now)
}

/** 按条件把当前结论差异标记为待重算，返回受影响差异 id */
async function markConflictsPendingWhere(
  predicate: (item: ConflictRow) => boolean,
  reason: string,
  now: number
): Promise<string[]> {
  const rows = await db.conflicts.toArray()
  const affected: string[] = []
  for (const row of rows) {
    if (row.state === ARCHIVED_CONFLICT_STATE || row.supersededBy !== '') continue
    if (!predicate(row)) continue
    row.state = ARCHIVED_CONFLICT_STATE
    row.supersededBy = ''
    row.recalcReason = reason
    row.recalcDone = false
    row.updatedAt = now
    await db.conflicts.put(toPlainRow(row))
    affected.push(row.id)
  }
  return affected
}

/** 重算候选：store 由 useContinuityDiff 的 DiffCandidate 映射而来 */
export interface RecalcCandidate {
  elementId: string
  recordIdA: string
  recordIdB: string
  diffDesc: string
  severity: ConflictSeverity
  /** 比对依据的记录行版本：重算前校验记录未被其他窗口改动，否则整体回滚 */
  recordARevision: number
  recordBRevision: number
}

export interface RecalcResult {
  /** 新生成的差异代数 */
  generated: number
  /** 被留档的旧结论条数 */
  archived: number
  /** 已是最新、跳过的条数 */
  unchanged: number
}

/**
 * 确认重算：按最近两次现场记录为要素生成新一代差异。
 * - 事务内执行：任何失败（含版本冲突）整体回滚，记录与差异恢复到动手前；
 * - 新一代差异 supersedes 指向被取代的旧结论，旧结论 supersededBy 回指新代并留档；
 * - 旧结论（含已解决）一律留档，不参与统计；重算后无差异的要素不生成新代。
 */
export async function recalculateConflicts(candidates: RecalcCandidate[]): Promise<RecalcResult> {
  return db.transaction('rw', [db.conflicts, db.records], async () => {
    const now = Date.now()
    const allConflicts = await db.conflicts.toArray()
    let generated = 0
    let archived = 0
    let unchanged = 0

    for (const cand of candidates) {
      // 乐观锁：比对依据的记录版本必须与库中一致，否则整体回滚
      const [recA, recB] = await Promise.all([db.records.get(cand.recordIdA), db.records.get(cand.recordIdB)])
      if (!recA || !recB) throw new Error('重算依据的现场记录不存在，已恢复到重算前')
      if (recA.revision !== cand.recordARevision || recB.revision !== cand.recordBRevision) {
        throw new VersionConflictError('现场记录')
      }

      const elementConflicts = allConflicts
        .filter((item) => item.elementId === cand.elementId)
        .sort((x, y) => y.version - x.version)
      const current = elementConflicts.find((item) => item.state !== ARCHIVED_CONFLICT_STATE && item.supersededBy === '') ?? null
      const pending = elementConflicts.filter(
        (item) => item.state === ARCHIVED_CONFLICT_STATE && item.supersededBy === ''
      )

      // 当前结论与候选完全一致（同一对记录、同一份描述）→ 已是最新，跳过
      if (
        current &&
        current.recordIdA === cand.recordIdA &&
        current.recordIdB === cand.recordIdB &&
        current.diffDesc === cand.diffDesc
      ) {
        unchanged += 1
        continue
      }

      const version = elementConflicts.reduce((max, item) => Math.max(max, item.version), 0) + 1
      const newRow: ConflictRow = {
        id: createId('conflict'),
        elementId: cand.elementId,
        recordIdA: cand.recordIdA,
        recordIdB: cand.recordIdB,
        diffDesc: cand.diffDesc,
        severity: cand.severity,
        state: '待确认',
        resolvedNote: '',
        resolvedAt: '',
        version,
        supersedes: current?.id ?? pending[0]?.id ?? '',
        supersededBy: '',
        recalcReason: '',
        recalcDone: false,
        revision: ROW_REVISION,
        createdAt: now,
        updatedAt: now
      }
      await db.conflicts.put(toPlainRow(newRow))

      const toSupersede = [...(current ? [current] : []), ...pending]
      for (const old of toSupersede) {
        old.supersededBy = newRow.id
        old.recalcDone = true
        if (old.state !== ARCHIVED_CONFLICT_STATE) old.state = ARCHIVED_CONFLICT_STATE
        old.updatedAt = now
        await db.conflicts.put(toPlainRow(old))
        archived += 1
      }
      generated += 1
    }

    // 待重算但本次已无差异的要素：不生成新代，旧结论留档并注明
    const covered = new Set(candidates.map((cand) => cand.elementId))
    for (const row of allConflicts) {
      if (row.state !== ARCHIVED_CONFLICT_STATE || row.supersededBy !== '') continue
      if (covered.has(row.elementId)) continue
      row.recalcDone = true
      row.recalcReason = `${row.recalcReason}（重算后最近两次记录已无差异，旧结论留档）`
      row.updatedAt = now
      await db.conflicts.put(toPlainRow(row))
    }

    return { generated, archived, unchanged }
  })
}

export interface ResolveExpected {
  conflictRevision?: number
  elementRevision?: number
}

/** 解决差异（乐观锁）：写入留痕并回写要素初始状态（登记新一代要素基准，来源：差异回写） */
export async function resolveConflict(
  id: string,
  resolvedNote: string,
  expected: ResolveExpected = {}
): Promise<void> {
  await db.transaction('rw', [db.conflicts, db.records, db.elements, db.baselineVersions], async () => {
    const conflict = await db.conflicts.get(id)
    if (!conflict) throw new Error('差异条目不存在')
    if (expected.conflictRevision !== undefined && conflict.revision !== expected.conflictRevision) {
      throw new VersionConflictError('连戏差异')
    }
    const latest = await db.records.get(conflict.recordIdB)
    const element = await db.elements.get(conflict.elementId)
    if (expected.elementRevision !== undefined && element && element.revision !== expected.elementRevision) {
      throw new VersionConflictError('连戏要素')
    }
    const now = Date.now()
    await db.conflicts.update(id, {
      state: '已解决',
      resolvedNote,
      resolvedAt: nowIso(),
      revision: conflict.revision + 1,
      updatedAt: now
    } as never)
    if (latest && element && element.initialState !== latest.currentState) {
      const versions = await db.baselineVersions.where('elementId').equals(conflict.elementId).toArray()
      const nextVersion = versions.reduce((max, item) => Math.max(max, item.version), 0) + 1
      await db.baselineVersions.put(
        toPlainRow(
          createBaselineVersion(
            conflict.elementId,
            nextVersion,
            latest.currentState,
            '差异回写',
            {
              id: createId('baselinever'),
              conflictId: id,
              recordId: latest.id,
              note: `解决差异时以最新现场状态为准（记录镜次 ${latest.takeNo}）`
            },
            now
          )
        )
      )
      await db.elements.update(conflict.elementId, {
        initialState: latest.currentState,
        revision: element.revision + 1,
        updatedAt: now
      } as never)
    }
  })
}

/** 重新打开差异（误判回退，乐观锁） */
export async function reopenConflict(id: string, expectedRevision?: number): Promise<void> {
  await db.transaction('rw', db.conflicts, async () => {
    const conflict = await db.conflicts.get(id)
    if (!conflict) throw new Error('差异条目不存在')
    if (expectedRevision !== undefined && conflict.revision !== expectedRevision) {
      throw new VersionConflictError('连戏差异')
    }
    const now = Date.now()
    await db.conflicts.update(id, {
      state: '待确认',
      resolvedNote: '',
      resolvedAt: '',
      revision: conflict.revision + 1,
      updatedAt: now
    } as never)
  })
}

export async function removeConflict(id: string): Promise<void> {
  await db.conflicts.delete(id)
}

/* --------------------------- 整库导入导出 --------------------------- */

export interface DatabaseSnapshot {
  name: string
  schemaVersion: number
  exportedAt: string
  scenes: Scene[]
  elements: Element[]
  shootDays: ShootDay[]
  records: ContinuityRecord[]
  conflicts: Conflict[]
  recordVersions: RecordVersion[]
  baselineVersions: BaselineVersion[]
}

function stripRow<T extends Revisioned>(row: T): Omit<T, keyof Revisioned> {
  const copy = { ...row } as Record<string, unknown>
  delete copy.revision
  delete copy.createdAt
  delete copy.updatedAt
  return copy as Omit<T, keyof Revisioned>
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [scenes, elements, shootDays, records, conflicts, recordVersions, baselineVersions] = await Promise.all([
    db.scenes.toArray(),
    db.elements.toArray(),
    db.shootDays.toArray(),
    db.records.toArray(),
    db.conflicts.toArray(),
    db.recordVersions.toArray(),
    db.baselineVersions.toArray()
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
    // 版本历史表保留 createdAt（无 revision/updatedAt），直接导出
    recordVersions,
    baselineVersions
  }
}

function stamp<T>(row: T): T & Revisioned {
  const now = Date.now()
  return { ...row, revision: ROW_REVISION, createdAt: now, updatedAt: now }
}

function stampCreatedAt<T>(row: T): T & { createdAt: number } {
  return { ...row, createdAt: Date.now() }
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.scenes, db.elements, db.shootDays, db.records, db.conflicts, db.recordVersions, db.baselineVersions],
    async () => {
      await Promise.all([
        db.scenes.clear(),
        db.elements.clear(),
        db.shootDays.clear(),
        db.records.clear(),
        db.conflicts.clear(),
        db.recordVersions.clear(),
        db.baselineVersions.clear()
      ])
      await db.scenes.bulkPut(snapshot.scenes.map(stamp))
      await db.elements.bulkPut(snapshot.elements.map(stamp))
      await db.shootDays.bulkPut(snapshot.shootDays.map(stamp))
      await db.records.bulkPut(snapshot.records.map(stamp))
      // 兼容旧备份：差异行可能缺版本链字段，补默认值
      await db.conflicts.bulkPut(
        snapshot.conflicts.map((item) =>
          stamp({
            ...item,
            state: item.state ?? '待确认',
            version: typeof item.version === 'number' ? item.version : 1,
            supersedes: item.supersedes ?? '',
            supersededBy: item.supersededBy ?? '',
            recalcReason: item.recalcReason ?? '',
            recalcDone: typeof item.recalcDone === 'boolean' ? item.recalcDone : false
          })
        )
      )
      await db.recordVersions.bulkPut((snapshot.recordVersions ?? []).map(stampCreatedAt))
      await db.baselineVersions.bulkPut((snapshot.baselineVersions ?? []).map(stampCreatedAt))
    }
  )
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.scenes, db.elements, db.shootDays, db.records, db.conflicts, db.recordVersions, db.baselineVersions],
    async () => {
      await Promise.all([
        db.scenes.clear(),
        db.elements.clear(),
        db.shootDays.clear(),
        db.records.clear(),
        db.conflicts.clear(),
        db.recordVersions.clear(),
        db.baselineVersions.clear()
      ])
    }
  )
  await seedDatabase()
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [scenes, elements, shootDays, records, conflicts, recordVersions, baselineVersions] = await Promise.all([
    db.scenes.count(),
    db.elements.count(),
    db.shootDays.count(),
    db.records.count(),
    db.conflicts.count(),
    db.recordVersions.count(),
    db.baselineVersions.count()
  ])
  return { scenes, elements, shootDays, records, conflicts, recordVersions, baselineVersions }
}
