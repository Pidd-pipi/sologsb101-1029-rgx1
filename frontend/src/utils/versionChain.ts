/**
 * 版本链核心动作：把现场记录、连戏差异与要素基准接成可追溯的版本链。
 *
 * 生命周期：
 * 1. 补记 / 更正旧记录（或修改要素基准）→ 同事务把相关差异置「待重算」并保存动手前快照；
 * 2. 确认重算 → 取最近两次记录重新比对：旧差异「已留档」（不参与统计），生成新一代差异；
 * 3. 重算任一步失败 → 按快照把记录、基准与差异恢复到动手前，并留下回滚留痕；
 * 4. 所有保存都校验乐观版本号：另一个标签页先保存时抛 VersionConflictError，拒绝覆盖。
 */
import type { Element } from '../types/element'
import type { Record as ContinuityRecord } from '../types/record'
import type { Conflict } from '../types/conflict'
import type { ChainActionType, ChainEntityType, ChainRevision } from '../types/chainRevision'
import {
  conflictChainGroup,
  db,
  ROW_REVISION,
  type ChainRevisionRow,
  type ConflictRow,
  type ElementRow,
  type RecordRow,
  type ShootDayRow
} from './db'
import { toPlainRow } from './db'
import { describeDiffs, diffRecords, severityOf } from './diff'
import { createId } from './uuid'
import { RecalculationError, VersionConflictError } from './errors'

/** 差异是否为参与统计的生效结论 */
function isActive(state: Conflict['state']): boolean {
  return state === '待确认' || state === '已解决'
}

/** 记录时间轴：先按拍摄日日期，再按镜次排序 */
function buildRecordTimeline(records: RecordRow[], shootDays: ShootDayRow[]): RecordRow[] {
  const dateOf = (record: RecordRow): string =>
    shootDays.find((day) => day.id === record.shootDayId)?.date ?? ''
  return [...records].sort(
    (a, b) => dateOf(a).localeCompare(dateOf(b)) || a.takeNo.localeCompare(b.takeNo, 'zh-Hans-CN')
  )
}

/** 写一条版本链留痕 */
async function logChain(params: {
  eventType: ChainActionType
  entityType: ChainEntityType
  entityId: string
  elementId?: string
  reason: string
  actor: string
  fromVersion?: number
  toVersion?: number
  chainGroup?: string
  supersededBy?: string
  snapshot?: unknown
  note?: string
}): Promise<void> {
  const now = Date.now()
  const row: ChainRevisionRow = {
    id: createId('chain'),
    eventType: params.eventType,
    entityType: params.entityType,
    entityId: params.entityId,
    elementId: params.elementId,
    reason: params.reason,
    actor: params.actor,
    fromVersion: params.fromVersion,
    toVersion: params.toVersion,
    chainGroup: params.chainGroup,
    supersededBy: params.supersededBy,
    snapshot: params.snapshot === undefined ? undefined : JSON.stringify(toPlainRow(params.snapshot)),
    note: params.note,
    revision: ROW_REVISION,
    createdAt: now,
    updatedAt: now
  }
  await db.chainRevisions.put(toPlainRow(row))
}

interface InvalidateContext {
  /** 按记录 id 收集动手前记录快照（只保留最早一份） */
  recordSnapshots: Map<string, RecordRow>
  invalidatedIds: string[]
}

/**
 * 把指定要素的生效差异置「待重算」，并在差异上保存动手前快照。
 * 必须在 rw 事务内调用。
 */
async function invalidateElementConflicts(
  elementIds: string[],
  reason: string,
  actor: string,
  ctx: InvalidateContext
): Promise<void> {
  const conflicts = await db.conflicts.where('elementId').anyOf(elementIds).toArray()
  for (const conflict of conflicts) {
    if (!isActive(conflict.state)) continue
    // 已经待重算（同一要素连续两次修改）：沿用第一次的快照，保证回滚目标始终是「动手前」
    if (conflict.state !== '待重算') {
      const snapshotPayload = {
        conflict: toPlainRow(conflict),
        records: {} as Record<string, RecordRow>
      }
      for (const recordId of [conflict.recordIdA, conflict.recordIdB]) {
        if (ctx.recordSnapshots.has(recordId)) {
          snapshotPayload.records[recordId] = ctx.recordSnapshots.get(recordId)!
        } else {
          const found = await db.records.get(recordId)
          if (found) {
            ctx.recordSnapshots.set(recordId, found)
            snapshotPayload.records[recordId] = found
          }
        }
      }
      await db.conflicts.update(conflict.id, {
        state: '待重算',
        preRecalcSnapshot: JSON.stringify(snapshotPayload),
        updatedAt: Date.now()
      } as never)
    }
    if (!ctx.invalidatedIds.includes(conflict.id)) ctx.invalidatedIds.push(conflict.id)
    await logChain({
      eventType: 'diff-invalidated',
      entityType: 'conflict',
      entityId: conflict.id,
      elementId: conflict.elementId,
      reason,
      actor,
      chainGroup: conflict.chainGroup
    })
  }
}

export interface AmendRecordOptions {
  id: string
  patch: Partial<ContinuityRecord>
  /** 编辑表单打开时读取到的版本号；与库内不一致说明已被其他标签页保存 */
  expectedVersion?: number
  reason: string
  actor: string
}

/**
 * 补记 / 更正一条旧现场记录：
 * - 乐观版本号校验，冲突时抛 VersionConflictError（库里最新行随错误返回）；
 * - 同事务把改动要素（含改前要素）的生效差异冻结为「待重算」；
 * - 记录版本 +1，差异留痕「diff-invalidated」，确认重算后才会生成新一代差异。
 */
export async function amendRecord(options: AmendRecordOptions): Promise<RecordRow> {
  return db.transaction('rw', [db.records, db.elements, db.conflicts, db.shootDays, db.chainRevisions], async () => {
    const before = await db.records.get(options.id)
    if (!before) throw new Error('现场记录不存在，可能已被其他标签页删除')
    if (typeof options.expectedVersion === 'number' && before.version !== options.expectedVersion) {
      throw new VersionConflictError(
        `该现场记录已被其他标签页保存为 v${before.version}，请载入最新版本后再修改`,
        before
      )
    }

    const affectedElementIds = [before.elementId]
    if (options.patch.elementId && !affectedElementIds.includes(options.patch.elementId)) {
      affectedElementIds.push(options.patch.elementId)
    }

    const ctx: InvalidateContext = { recordSnapshots: new Map(), invalidatedIds: [] }
    // 先收集相关要素生效差异引用到的记录的动手前快照
    const relatedConflicts = await db.conflicts.where('elementId').anyOf(affectedElementIds).toArray()
    for (const conflict of relatedConflicts) {
      if (!isActive(conflict.state)) continue
      for (const recordId of [conflict.recordIdA, conflict.recordIdB]) {
        if (!ctx.recordSnapshots.has(recordId)) {
          const found = await db.records.get(recordId)
          if (found) ctx.recordSnapshots.set(recordId, found)
        }
      }
    }
    ctx.recordSnapshots.set(before.id, before)

    const nextVersion = before.version + 1
    const now = Date.now()
    const next: RecordRow = {
      ...toPlainRow(before),
      ...toPlainRow(options.patch),
      version: nextVersion,
      revision: before.revision,
      createdAt: before.createdAt,
      updatedAt: now
    } as RecordRow
    await db.records.put(toPlainRow(next))

    await invalidateElementConflicts(affectedElementIds, options.reason || '现场记录被补记 / 更正', options.actor, ctx)

    await logChain({
      eventType: 'record-amended',
      entityType: 'record',
      entityId: before.id,
      elementId: next.elementId,
      reason: options.reason,
      actor: options.actor,
      fromVersion: before.version,
      toVersion: nextVersion,
      snapshot: before
    })

    return next
  })
}

export interface AmendElementOptions {
  id: string
  patch: Partial<Element>
  expectedVersion?: number
  reason: string
  actor: string
}

/**
 * 修改连戏要素：
 * - 乐观版本号校验，冲突时抛 VersionConflictError；
 * - 若改的是基准字段（初始状态 / 关键标记），同事务把该要素生效差异冻结为「待重算」；
 * - 其他字段（名称 / 责任人 / 类别 / 场次）不影响已生成结论，只做版本递增。
 */
export async function amendElement(options: AmendElementOptions): Promise<ElementRow> {
  return db.transaction('rw', [db.elements, db.records, db.conflicts, db.chainRevisions], async () => {
    const before = await db.elements.get(options.id)
    if (!before) throw new Error('连戏要素不存在，可能已被其他标签页删除')
    if (typeof options.expectedVersion === 'number' && before.version !== options.expectedVersion) {
      throw new VersionConflictError(
        `该要素基准已被其他标签页保存为 v${before.version}，请载入最新版本后再修改`,
        before
      )
    }

    const baselineChanged =
      (typeof options.patch.initialState === 'string' && options.patch.initialState !== before.initialState) ||
      (typeof options.patch.critical === 'boolean' && options.patch.critical !== before.critical)

    const nextVersion = before.version + 1
    const now = Date.now()
    const next: ElementRow = {
      ...toPlainRow(before),
      ...toPlainRow(options.patch),
      version: nextVersion,
      revision: before.revision,
      createdAt: before.createdAt,
      updatedAt: now
    } as ElementRow
    await db.elements.put(toPlainRow(next))

    if (baselineChanged) {
      const ctx: InvalidateContext = { recordSnapshots: new Map(), invalidatedIds: [] }
      await invalidateElementConflicts(
        [before.id],
        options.reason || '要素基准（初始状态 / 关键标记）被修改',
        options.actor,
        ctx
      )
      await logChain({
        eventType: 'element-baseline-changed',
        entityType: 'element',
        entityId: before.id,
        elementId: before.id,
        reason: options.reason,
        actor: options.actor,
        fromVersion: before.version,
        toVersion: nextVersion,
        snapshot: before
      })
    }

    return next
  })
}

/** 重算结果 */
export interface RecalcResult {
  archived: number
  created: number
  elementId: string
}

/** 留痕类型再导出，供页面订阅 */
export type { ChainRevision, ChainRevisionRow }

/**
 * 确认重算单个要素：取最近两次现场记录重新比对。
 * - 旧差异（待重算）置「已留档」并写入继任者，不参与统计；
 * - 依据当前记录 / 基准版本生成新一代差异（无差异则不生成）；
 * - 任一步抛错，整个事务由 Dexie 自动回滚。
 */
export async function recalculateElement(elementId: string, actor: string): Promise<RecalcResult> {
  // 事务外先记下动手前的待重算差异，失败补偿时按这批 id 恢复（不依赖事务后的库状态）
  const pendingBefore = await db.conflicts
    .where('elementId')
    .equals(elementId)
    .filter((item) => item.state === '待重算')
    .toArray()
  try {
    return await db.transaction(
      'rw',
      [db.records, db.elements, db.conflicts, db.shootDays, db.chainRevisions],
      async () => {
        const element = await db.elements.get(elementId)
        if (!element) throw new Error(`连戏要素 ${elementId} 已不存在`)
        const allRecords = await db.records.where('elementId').equals(elementId).toArray()
        const shootDays = await db.shootDays.toArray()
        const timeline = buildRecordTimeline(allRecords, shootDays)
        const allConflicts = await db.conflicts.toArray()

        const pending = pendingBefore

        // 1) 先依据当前记录 / 基准版本算出新一代差异（暂不写库）
        let newConflict: ConflictRow | null = null
        if (timeline.length >= 2) {
          const a = timeline[timeline.length - 2]
          const b = timeline[timeline.length - 1]
          const diffs = diffRecords(a, b)
          const severity = severityOf(diffs, element.critical)
          if (severity) {
            const group = conflictChainGroup(elementId, a.id, b.id)
            // 同分组已有生效结论（待确认 / 已解决）则不重复生成；
            // 本要素的待重算行马上会归档、已留档行是前代，均不阻挡新一代生成
            const exists = allConflicts.some(
              (item) => item.chainGroup === group && (item.state === '待确认' || item.state === '已解决')
            )
            if (!exists) {
              const generation =
                allConflicts.filter((item) => item.chainGroup === group).reduce((max, item) => Math.max(max, item.generation), 0) + 1
              newConflict = {
                id: createId('conflict'),
                elementId,
                recordIdA: a.id,
                recordIdB: b.id,
                diffDesc: describeDiffs(diffs),
                severity,
                state: '待确认',
                resolvedNote: '',
                resolvedAt: '',
                chainGroup: group,
                generation,
                recordAVersion: a.version,
                recordBVersion: b.version,
                baselineVersion: element.version,
                supersededBy: '',
                preRecalcSnapshot: '',
                revision: ROW_REVISION,
                createdAt: Date.now(),
                updatedAt: Date.now()
              }
            }
          }
        }

        // 2) 旧结论留档：清掉回滚快照、写入继任者
        for (const conflict of pending) {
          await db.conflicts.update(conflict.id, {
            state: '已留档',
            supersededBy: newConflict ? newConflict.id : '',
            preRecalcSnapshot: '',
            updatedAt: Date.now()
          } as never)
          await logChain({
            eventType: 'diff-archived',
            entityType: 'conflict',
            entityId: conflict.id,
            elementId,
            reason: '确认重算后，旧结论留档（不参与统计）',
            actor,
            chainGroup: conflict.chainGroup,
            supersededBy: newConflict ? newConflict.id : undefined
          })
        }

        // 3) 写入新一代差异并留痕
        if (newConflict) {
          await db.conflicts.put(toPlainRow(newConflict))
          await logChain({
            eventType: 'diff-regenerated',
            entityType: 'conflict',
            entityId: newConflict.id,
            elementId,
            reason: `确认重算生成第 ${newConflict.generation} 代差异`,
            actor,
            toVersion: newConflict.generation,
            chainGroup: newConflict.chainGroup
          })
        }

        return { archived: pending.length, created: newConflict ? 1 : 0, elementId }
      }
    )
  } catch (error) {
    if (error instanceof RecalculationError || error instanceof VersionConflictError) throw error
    await rollbackPendingElement(elementId, pendingBefore.map((item) => item.id), actor, error)
    throw new RecalculationError('重算失败，相关现场记录、要素基准与差异已恢复到动手前', error)
  }
}

/**
 * 重算失败的补偿回滚：
 * - 待重算差异按各自快照恢复（状态、快照字段）；
 * - 差异引用记录恢复到「动手前」版本（取该要素最早的失效事件链快照）；
 * - 要素基准恢复到待重算周期前的版本；
 * - 留下 amend-rolled-back / recalc-rolled-back 留痕。
 */
async function rollbackPendingElement(elementId: string, pendingIds: string[], actor: string, cause: unknown): Promise<void> {
  try {
    await db.transaction(
      'rw',
      [db.records, db.elements, db.conflicts, db.shootDays, db.chainRevisions],
      async () => {
        // 主事务已被 Dexie 自动回滚，这里按事务前的 id 取行并以快照兜底恢复
        const byId = await Promise.all(pendingIds.map((id) => db.conflicts.get(id)))
        const pending = byId.filter((item): item is ConflictRow => Boolean(item))

        const recordRestore = new Map<string, RecordRow>()
        for (const conflict of pending) {
          const snapshotText = conflict.preRecalcSnapshot
          if (snapshotText) {
            try {
              const payload = JSON.parse(snapshotText) as {
                conflict?: ConflictRow
                records?: Record<string, RecordRow>
              }
              if (payload.conflict) {
                await db.conflicts.put(toPlainRow(payload.conflict))
              }
              for (const [recordId, snapshot] of Object.entries(payload.records ?? {})) {
                if (!recordRestore.has(recordId)) recordRestore.set(recordId, snapshot)
              }
            } catch {
              // 快照损坏无法恢复，保持现状并留痕说明
              await logChain({
                eventType: 'recalc-rolled-back',
                entityType: 'conflict',
                entityId: conflict.id,
                elementId,
                reason: `重算失败，且差异快照损坏无法自动恢复：${String(cause)}`,
                actor,
                chainGroup: conflict.chainGroup
              })
            }
          }
        }

        for (const [, snapshot] of recordRestore) {
          await db.records.put(toPlainRow(snapshot))
          await logChain({
            eventType: 'amend-rolled-back',
            entityType: 'record',
            entityId: snapshot.id,
            elementId: snapshot.elementId,
            reason: '重算失败，现场记录恢复到动手前',
            actor,
            toVersion: snapshot.version,
            snapshot
          })
        }

        // 要素基准：取该要素最早一条基准修改事件的快照恢复
        const baselineEvents = await db.chainRevisions
          .where('elementId')
          .equals(elementId)
          .filter((item) => item.eventType === 'element-baseline-changed')
          .toArray()
        const earliestBaseline = baselineEvents.sort((a, b) => a.createdAt - b.createdAt)[0]
        if (earliestBaseline?.snapshot) {
          try {
            const snapshot = JSON.parse(earliestBaseline.snapshot) as ElementRow
            await db.elements.put(toPlainRow(snapshot))
          } catch {
            // 快照损坏，保持现状
          }
        }

        for (const conflict of pending) {
          await logChain({
            eventType: 'recalc-rolled-back',
            entityType: 'conflict',
            entityId: conflict.id,
            elementId,
            reason: '重算失败，差异恢复到动手前',
            actor,
            chainGroup: conflict.chainGroup
          })
        }
      }
    )
  } catch {
    // 回滚事务本身失败时不再抛出，原始错误已由调用方包装
  }
}

/** 所有存在「待重算」差异的要素 id（供批量确认） */
export async function listPendingElementIds(): Promise<string[]> {
  const pending = await db.conflicts.filter((item) => item.state === '待重算').toArray()
  return [...new Set(pending.map((item) => item.elementId))]
}

/**
 * 首次「重新比对生成差异」：对全部要素取最近两次记录生成待确认差异。
 * 已存在同分组生效 / 待重算结论的不重复生成。
 */
export async function generateInitialConflicts(actor: string): Promise<number> {
  return db.transaction(
    'rw',
    [db.elements, db.records, db.conflicts, db.shootDays, db.chainRevisions],
    async () => {
      const elements = await db.elements.toArray()
      const records = await db.records.toArray()
      const shootDays = await db.shootDays.toArray()
      const existing = await db.conflicts.toArray()
      let created = 0

      for (const element of elements) {
        const own = buildRecordTimeline(
          records.filter((record) => record.elementId === element.id),
          shootDays
        )
        if (own.length < 2) continue
        const a = own[own.length - 2]
        const b = own[own.length - 1]
        const diffs = diffRecords(a, b)
        const severity = severityOf(diffs, element.critical)
        if (!severity) continue
        const group = conflictChainGroup(element.id, a.id, b.id)
        const dup = existing.some(
          (item) =>
            item.chainGroup === group &&
            (item.state === '待确认' || item.state === '已解决' || item.state === '待重算')
        )
        if (dup) continue
        const generation =
          existing.filter((item) => item.chainGroup === group).reduce((max, item) => Math.max(max, item.generation), 0) + 1
        const now = Date.now()
        const id = createId('conflict')
        const row: ConflictRow = {
          id,
          elementId: element.id,
          recordIdA: a.id,
          recordIdB: b.id,
          diffDesc: describeDiffs(diffs),
          severity,
          state: '待确认',
          resolvedNote: '',
          resolvedAt: '',
          chainGroup: group,
          generation,
          recordAVersion: a.version,
          recordBVersion: b.version,
          baselineVersion: element.version,
          supersededBy: '',
          preRecalcSnapshot: '',
          revision: ROW_REVISION,
          createdAt: now,
          updatedAt: now
        }
        await db.conflicts.put(toPlainRow(row))
        existing.push(row)
        created += 1
        await logChain({
          eventType: 'diff-regenerated',
          entityType: 'conflict',
          entityId: id,
          elementId: element.id,
          reason: `重新比对生成第 ${generation} 代差异`,
          actor,
          toVersion: generation,
          chainGroup: group
        })
      }
      return created
    }
  )
}

export interface ResolveConflictOptions {
  id: string
  note: string
  actor: string
  /** 打开解决弹窗时读取到的要素基准版本；与库内不一致则拒绝（另一标签页刚改了基准） */
  expectedBaselineVersion?: number
}

/** 确认解决：写解决留痕、回写要素基准为最新现场状态（版本 +1） */
export async function resolveConflictGuarded(options: ResolveConflictOptions): Promise<void> {
  await db.transaction('rw', [db.conflicts, db.records, db.elements, db.chainRevisions], async () => {
    const conflict = await db.conflicts.get(options.id)
    if (!conflict) throw new Error('差异条目不存在')
    if (conflict.state !== '待确认') throw new Error('只有「待确认」差异可以确认解决')
    const element = await db.elements.get(conflict.elementId)
    if (!element) throw new Error('差异关联的要素已不存在')
    if (
      typeof options.expectedBaselineVersion === 'number' &&
      conflict.baselineVersion > 0 &&
      element.version !== options.expectedBaselineVersion
    ) {
      throw new VersionConflictError(
        `该要素基准刚被其他标签页修改（v${options.expectedBaselineVersion} → v${element.version}），请先确认重算再解决`,
        element
      )
    }

    const latest = await db.records.get(conflict.recordIdB)
    const fromBaselineVersion = element.version
    await db.conflicts.update(options.id, {
      state: '已解决',
      resolvedNote: options.note,
      resolvedAt: new Date().toISOString(),
      updatedAt: Date.now()
    } as never)

    let toBaselineVersion = element.version
    if (latest && latest.currentState !== element.initialState) {
      toBaselineVersion = element.version + 1
      await db.elements.update(conflict.elementId, {
        initialState: latest.currentState,
        version: toBaselineVersion,
        updatedAt: Date.now()
      } as never)
    }

    await logChain({
      eventType: 'diff-resolved',
      entityType: 'conflict',
      entityId: options.id,
      elementId: conflict.elementId,
      reason: options.note,
      actor: options.actor,
      chainGroup: conflict.chainGroup
    })
    if (latest && latest.currentState !== element.initialState) {
      await logChain({
        eventType: 'baseline-writeback',
        entityType: 'element',
        entityId: conflict.elementId,
        elementId: conflict.elementId,
        reason: `解决差异 ${options.id} 后回写基准为最新现场状态`,
        actor: options.actor,
        fromVersion: fromBaselineVersion,
        toVersion: toBaselineVersion
      })
    }
  })
}

/** 重新打开已解决差异（误判回退） */
export async function reopenConflictGuarded(id: string, actor: string): Promise<void> {
  await db.transaction('rw', [db.conflicts, db.chainRevisions], async () => {
    const conflict = await db.conflicts.get(id)
    if (!conflict) throw new Error('差异条目不存在')
    if (conflict.state !== '已解决') throw new Error('只有「已解决」差异可以重新打开')
    await db.conflicts.update(id, {
      state: '待确认',
      resolvedNote: '',
      resolvedAt: '',
      updatedAt: Date.now()
    } as never)
    await logChain({
      eventType: 'diff-reopened',
      entityType: 'conflict',
      entityId: id,
      elementId: conflict.elementId,
      reason: '误判回退，差异重新打开为待确认',
      actor,
      chainGroup: conflict.chainGroup
    })
  })
}
