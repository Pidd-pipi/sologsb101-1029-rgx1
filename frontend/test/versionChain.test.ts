/**
 * 版本链端到端验证（Node + fake-indexeddb，不走浏览器）：
 * 1. 建要素 / 拍摄日 / 两条记录 → 首次比对生成差异；
 * 2. 补记更正旧记录 → 旧差异冻结「待重算」，统计口径排除；
 * 3. 版本冲突：另一标签页先保存 → 后保存方收到 VersionConflictError；
 * 4. 确认重算 → 旧差异「已留档」、新一代「待确认」，链路字段互指；
 * 5. 重算失败回滚：mock 抛错后记录版本、差异状态恢复动手前；
 * 6. 解决差异 → 回写要素基准并升版、留痕。
 */
import 'fake-indexeddb/auto'
import { strict as assert } from 'node:assert'
import {
  db,
  ROW_REVISION,
  INITIAL_VERSION,
  type ElementRow,
  type ShootDayRow,
  type RecordRow,
  type ConflictRow,
  conflictChainGroup
} from '../src/utils/db'
import {
  amendRecord,
  recalculateElement,
  generateInitialConflicts,
  resolveConflictGuarded
} from '../src/utils/versionChain'
import { VersionConflictError, RecalculationError } from '../src/utils/errors'

const now = Date.now()

async function seed(): Promise<{ element: ElementRow; day: ShootDayRow; r1: RecordRow; r2: RecordRow }> {
  const element: ElementRow = {
    id: 'el-test',
    sceneId: 'sc-test',
    category: '服装',
    name: '测试风衣',
    initialState: '深蓝风衣，第二颗扣子缺失',
    owner: '林岚',
    critical: true,
    version: INITIAL_VERSION,
    revision: ROW_REVISION,
    createdAt: now,
    updatedAt: now
  }
  const day: ShootDayRow = {
    id: 'sd-test',
    date: '2024-05-06',
    sceneIds: ['sc-test'],
    director: '郑',
    scripty: '苏晚',
    weatherNote: '',
    revision: ROW_REVISION,
    createdAt: now,
    updatedAt: now
  }
  const mk = (id: string, takeNo: string, state: string, dayId = day.id, date = '2024-05-06'): RecordRow => ({
    id,
    shootDayId: dayId,
    elementId: element.id,
    sceneId: 'sc-test',
    takeNo,
    currentState: state,
    photoNote: '',
    recordedBy: '苏晚',
    version: INITIAL_VERSION,
    revision: ROW_REVISION,
    createdAt: now,
    updatedAt: now
  })
  const day2: ShootDayRow = { ...day, id: 'sd-test-2', date: '2024-05-07' }
  const r1 = mk('rec-a', '3/1', '深蓝风衣，第二颗扣子缺失')
  const r2 = mk('rec-b', '7/2', '深蓝风衣，第三颗扣子缺失', day2.id, '2024-05-07')
  await db.scenes.put({
    id: 'sc-test',
    sceneNo: '1',
    place: '内景',
    timeOfDay: '夜',
    location: '客厅',
    excerpt: '',
    shootOrder: 1,
    state: '拍摄中',
    revision: ROW_REVISION,
    createdAt: now,
    updatedAt: now
  })
  await db.elements.put(element)
  await db.shootDays.bulkPut([day, day2])
  await db.records.bulkPut([r1, r2])
  return { element, day, r1, r2 }
}

async function reset(): Promise<void> {
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
}

async function main(): Promise<void> {
  await db.open()

  // ---- 1. 首次比对 ----
  const { element, r1, r2 } = await seed()
  const created = await generateInitialConflicts('tester')
  assert.equal(created, 1, '首次比对应生成 1 条差异')
  let c1 = (await db.conflicts.toArray())[0]
  assert.equal(c1.state, '待确认')
  assert.equal(c1.severity, '阻断')
  assert.equal(c1.generation, 1)
  assert.equal(c1.chainGroup, conflictChainGroup(element.id, r1.id, r2.id))

  // ---- 2. 补记旧记录 → 旧差异待重算 ----
  const amended = await amendRecord({
    id: r1.id,
    patch: { currentState: '深蓝风衣，第二颗扣子缺失（已缝补）' },
    expectedVersion: 1,
    reason: '白天镜次补记',
    actor: '苏晚'
  })
  assert.equal(amended.version, 2, '记录应升版到 v2')
  c1 = (await db.conflicts.get(c1.id))!
  assert.equal(c1.state, '待重算', '旧差异应冻结为待重算')
  assert.ok(c1.preRecalcSnapshot.length > 0, '待重算差异应保存动手前快照')

  // ---- 3. 版本冲突：另一标签页刚保存 ----
  await assert.rejects(
    () =>
      amendRecord({
        id: r1.id,
        patch: { currentState: '另一个标签页视角的旧内容' },
        expectedVersion: 1, // 手里还是 v1
        reason: '并发保存',
        actor: '乙'
      }),
    (error: unknown) => error instanceof VersionConflictError,
    '应抛 VersionConflictError'
  )
  const still = await db.records.get(r1.id)
  assert.equal(still!.currentState, '深蓝风衣，第二颗扣子缺失（已缝补）', '后保存方不得覆盖先写入状态')
  assert.equal(still!.version, 2, '冲突时版本保持 v2')

  // ---- 4. 确认重算：旧留档 + 新一代 ----
  const result = await recalculateElement(element.id, 'tester')
  assert.equal(result.archived, 1)
  assert.equal(result.created, 1)
  const after = await db.conflicts.toArray()
  const archived = after.find((item) => item.id === c1.id)!
  assert.equal(archived.state, '已留档')
  assert.equal(archived.preRecalcSnapshot, '', '归档后应清空回滚快照')
  assert.ok(archived.supersededBy, '归档行应指向继任差异')
  const gen2 = after.find((item) => item.id === archived.supersededBy)!
  assert.equal(gen2.state, '待确认')
  assert.equal(gen2.generation, 2)
  assert.equal(gen2.recordAVersion, 2, '新一代差异应依据 v2 记录')
  assert.equal(gen2.recordBVersion, 1)
  assert.equal(gen2.chainGroup, c1.chainGroup, '同对记录共享版本链分组')

  // 留痕事件检查
  const events = await db.chainRevisions.toArray()
  const types = events.map((e) => e.eventType)
  assert.ok(types.includes('record-amended'))
  assert.ok(types.includes('diff-invalidated'))
  assert.ok(types.includes('diff-archived'))
  assert.ok(types.includes('diff-regenerated'))

  // ---- 5. 重算失败回滚 ----
  await reset()
  const { element: el2, r1: rr1 } = await seed()
  await generateInitialConflicts('tester')
  await amendRecord({
    id: rr1.id,
    patch: { currentState: '完全不同的补记内容' },
    expectedVersion: 1,
    reason: '再次补记',
    actor: '苏晚'
  })
  const stale = (await db.conflicts.where('elementId').equals(el2.id).toArray()).find((c) => c.state === '待重算')!
  assert.ok(stale)
  // 删除要素制造重算失败
  await db.elements.delete(el2.id)
  await assert.rejects(
    () => recalculateElement(el2.id, 'tester'),
    (error: unknown) => error instanceof RecalculationError,
    '应抛 RecalculationError'
  )
  // 补回要素名以检查回滚结果（删除要素是测试制造的失败，不属于回滚范围）
  const rollbackRecord = await db.records.get(rr1.id)
  assert.equal(rollbackRecord!.currentState, '深蓝风衣，第二颗扣子缺失', '失败后记录应恢复到动手前')
  assert.equal(rollbackRecord!.version, 1, '失败后记录版本应回到 v1')
  // 重新放回要素后，差异应已恢复为待重算
  await db.elements.put({
    id: el2.id,
    sceneId: 'sc-test',
    category: '服装',
    name: '测试风衣',
    initialState: '深蓝风衣，第二颗扣子缺失',
    owner: '林岚',
    critical: true,
    version: 1,
    revision: ROW_REVISION,
    createdAt: now,
    updatedAt: now
  })
  const restoredConflict = await db.conflicts.get(stale.id)
  assert.equal(restoredConflict!.state, '待确认', '失败后差异应恢复到动手前的待确认状态')

  // ---- 6. 解决差异回写基准（再次补记 → 重算 → 解决） ----
  await amendRecord({
    id: rr1.id,
    patch: { currentState: '深蓝风衣，第二颗扣子缺失，补拍确认' },
    expectedVersion: 1,
    reason: '回滚后重新补记',
    actor: '苏晚'
  })
  const recResult = await recalculateElement(el2.id, 'tester')
  assert.equal(recResult.created, 1, '再次补记后重算应生成新一代差异')
  const open = (await db.conflicts.where('elementId').equals(el2.id).toArray()).find((c) => c.state === '待确认')!
  const elBefore = await db.elements.get(el2.id)
  await resolveConflictGuarded({ id: open.id, note: '确认以最新状态为准', actor: '导演' })
  const resolved = await db.conflicts.get(open.id)
  assert.equal(resolved!.state, '已解决')
  const elAfter = await db.elements.get(el2.id)
  assert.equal(elAfter!.initialState, '深蓝风衣，第三颗扣子缺失', '基准应回写为记录 B 的最新状态')
  assert.equal(elAfter!.version, (elBefore!.version ?? 1) + 1, '基准应升版')

  console.log('全部版本链端到端断言通过 ✅')
}

main()
  .then(() => db.close())
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
