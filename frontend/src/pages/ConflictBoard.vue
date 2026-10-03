<script setup lang="ts">
/** /conflicts 连戏差异比对与冲突提示：版本链生命周期（待确认 / 待重算 / 已留档 / 已解决） */
import { computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh, Select } from '@element-plus/icons-vue'
import ConflictTag from '@/components/common/ConflictTag.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { db, type ConflictRow, type ElementRow, type RecordRow, type SceneRow, type ShootDayRow } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useContinuityDiff } from '@/hooks/useContinuityDiff'
import { useConflictStore } from '@/stores/conflictStore'
import { CONFLICT_SEVERITIES, CONFLICT_STATES, ACTIVE_CONFLICT_STATES } from '@/types/conflict'
import { isRecalculationError, isVersionConflictError } from '@/utils/errors'
import { SEVERITY_WEIGHT } from '@/utils/diff'
import type { FilterSelectConfig, FilterModel } from '@/types/filter'
import { filtersToQuery } from '@/utils/query'

const route = useRoute()
const router = useRouter()
const store = useConflictStore()

const { rows: conflicts, ready } = useIdbTable<ConflictRow>(() => db.conflicts)
const { rows: records } = useIdbTable<RecordRow>(() => db.records)
const { rows: elements } = useIdbTable<ElementRow>(() => db.elements)
const { rows: scenes } = useIdbTable<SceneRow>(() => db.scenes, { compare: (a, b) => a.shootOrder - b.shootOrder })
const { rows: shootDays } = useIdbTable<ShootDayRow>(() => db.shootDays)

/** 现场记录的字段级比对结果（首次比对候选数） */
const diff = useContinuityDiff(records, elements, shootDays)

const selects: FilterSelectConfig[] = [
  { key: 'severities', label: '严重程度', options: CONFLICT_SEVERITIES.map((item) => ({ label: item, value: item })) },
  { key: 'states', label: '处理状态', options: CONFLICT_STATES.map((item) => ({ label: item, value: item })) }
]

function recordOf(id: string): RecordRow | null {
  return records.value.find((item) => item.id === id) ?? null
}

function elementOf(elementId: string): ElementRow | null {
  return elements.value.find((item) => item.id === elementId) ?? null
}

function sceneLabelOf(elementId: string): string {
  const element = elementOf(elementId)
  if (!element) return '要素已删除'
  const scene = scenes.value.find((item) => item.id === element.sceneId)
  return scene ? `第 ${scene.sceneNo} 场 · ${scene.location}` : '场次已删除'
}

function dayLabelOf(record: RecordRow | null): string {
  if (!record) return '记录已删除'
  return shootDays.value.find((item) => item.id === record.shootDayId)?.date ?? '未知拍摄日'
}

/** 同分组的历代差异（世代链） */
function chainOf(row: ConflictRow): ConflictRow[] {
  return conflicts.value
    .filter((item) => item.chainGroup === row.chainGroup)
    .sort((a, b) => a.generation - b.generation)
}

const STATE_ORDER: Record<ConflictRow['state'], number> = {
  待重算: 0,
  待确认: 1,
  已解决: 2,
  已留档: 3
}

const filtered = computed(() => {
  const keyword = String(store.filters.keyword ?? '').trim().toLowerCase()
  const severities = Array.isArray(store.filters.severities) ? store.filters.severities : []
  const states = Array.isArray(store.filters.states) ? store.filters.states : []
  return conflicts.value
    .filter((conflict) => {
      const element = elementOf(conflict.elementId)
      const label = `${element ? element.name : ''} ${conflict.diffDesc}`.toLowerCase()
      if (keyword && !label.includes(keyword)) return false
      if (severities.length > 0 && !severities.includes(conflict.severity)) return false
      if (states.length > 0 && !states.includes(conflict.state)) return false
      return true
    })
    .sort(
      (a, b) =>
        STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
        SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity]
    )
})

const staleConflicts = computed(() => conflicts.value.filter((item) => item.state === '待重算'))
const staleElementIds = computed(() => [...new Set(staleConflicts.value.map((item) => item.elementId))])

const totals = computed(() => {
  // 统计口径：待确认 / 已解决参与统计；待重算（冻结）、已留档（归档）不参与
  const open = conflicts.value.filter((item) => item.state === '待确认')
  const active = conflicts.value.filter((item) => ACTIVE_CONFLICT_STATES.includes(item.state))
  return {
    activeTotal: active.length,
    open: open.length,
    resolved: conflicts.value.filter((item) => item.state === '已解决').length,
    blocking: open.filter((item) => item.severity === '阻断').length,
    stale: staleConflicts.value.length,
    staleElements: staleElementIds.value.length,
    archived: conflicts.value.filter((item) => item.state === '已留档').length,
    pendingCandidates: diff.diffCount.value
  }
})

/** 首次重新比对：为全部要素生成待确认差异 */
async function regenerate(): Promise<void> {
  try {
    if (totals.value.stale > 0) {
      ElMessage.warning(`有 ${totals.value.stale} 条差异待重算，请先「确认重算」后再做全量比对`)
      return
    }
    if (diff.candidates.value.length === 0) {
      ElMessage.info('当前没有可生成的差异（每个要素至少需要两次现场记录）')
      return
    }
    const created = await store.generateInitial()
    ElMessage.success(created > 0 ? `本次新生成 ${created} 条差异` : '差异已是新的，无需重复生成')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '比对失败')
  }
}

/** 确认重算单个要素 */
async function confirmRecalc(elementId: string): Promise<void> {
  try {
    const result = await store.confirmRecalc(elementId)
    ElMessage.success(
      `已确认重算：${result.archived} 条旧结论留档，${result.created > 0 ? `生成 ${result.created} 条新一代差异` : '重算后无差异'}`
    )
  } catch (error) {
    if (isRecalculationError(error)) {
      ElMessage.error(`${error.message}，请检查后重试`)
    } else {
      ElMessage.error(error instanceof Error ? error.message : '重算失败，记录与差异已恢复到动手前')
    }
  }
}

/** 批量确认重算全部待重算要素 */
async function confirmRecalcAll(): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `将对 ${staleElementIds.value.length} 个要素确认重算：旧差异留档、按最近两次记录生成新一代差异；失败的要素会自动回滚。是否继续？`,
      '确认重算',
      { type: 'warning', confirmButtonText: '全部确认重算' }
    )
  } catch {
    return
  }
  try {
    const result = await store.confirmRecalcAll()
    ElMessage.success(
      `已重算 ${result.confirmed} 个要素：${result.archived} 条旧结论留档，新生成 ${result.created} 条差异`
    )
  } catch (error) {
    if (isRecalculationError(error)) ElMessage.error(`${error.message}，请检查后重试`)
    else ElMessage.error(error instanceof Error ? error.message : '重算失败')
  }
}

async function resolve(conflict: ConflictRow): Promise<void> {
  try {
    const element = elementOf(conflict.elementId)
    const { value } = await ElMessageBox.prompt('请填写处理说明，确认后会把要素初始状态回写为最新现场状态', '消解冲突', {
      inputValue: '已按现场实际状态统一并留痕',
      confirmButtonText: '确认解决',
      cancelButtonText: '取消'
    })
    await store.resolve(conflict.id, {
      note: value,
      actor: element?.owner ?? '差异比对',
      expectedBaselineVersion: element?.version
    })
    ElMessage.success('冲突已解决并回写要素状态')
  } catch (error) {
    if (isVersionConflictError(error)) {
      ElMessage.error('该要素基准刚被其他标签页修改，相关差异需先确认重算')
      return
    }
    if (error instanceof Error && error.message) ElMessage.error(error.message)
  }
}

async function reopen(conflict: ConflictRow): Promise<void> {
  try {
    await store.reopen(conflict.id)
    ElMessage.success('已重新打开为待确认')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '操作失败')
  }
}

async function remove(conflict: ConflictRow): Promise<void> {
  if (conflict.state === '待重算') {
    ElMessage.warning('待重算差异是旧记录修改后的冻结结论，请先「确认重算」（失败会自动回滚）')
    return
  }
  try {
    await ElMessageBox.confirm('删除该差异条目不改变现场记录，是否继续？', '删除确认', { type: 'warning' })
  } catch {
    return
  }
  await store.remove(conflict.id)
  ElMessage.success('差异条目已删除')
}

function onFilterChange(next: FilterModel): void {
  store.setFilters(next)
}

function rowClassName({ row }: { row: ConflictRow }): string {
  return row.state === '已留档' ? 'row-archived' : ''
}

onMounted(() => {
  store.applyQuery(route.query)
})

watch(
  () => store.filters,
  (value) => {
    void router.replace({ path: route.path, query: filtersToQuery(value) })
  },
  { deep: true }
)
</script>

<template>
  <div class="page">
    <div class="page__head">
      <div>
        <h2 class="page__title">连戏差异比对与冲突提示</h2>
        <p class="page__subtitle">
          同一要素取最近两次现场记录做字段级比对；旧记录补记后差异先冻结「待重算」，确认后才生成新一代，旧结论留档不参与统计。
        </p>
      </div>
      <div>
        <el-button
          v-if="totals.stale > 0"
          type="danger"
          :icon="Select"
          @click="confirmRecalcAll"
        >
          全部确认重算（{{ totals.staleElements }} 个要素 / {{ totals.stale }} 条）
        </el-button>
        <el-button type="primary" :icon="Refresh" @click="regenerate">重新比对生成差异</el-button>
      </div>
    </div>

    <div class="badge-row">
      <StatBadge label="生效差异" :value="totals.activeTotal" suffix="条" icon="Files" tone="primary" />
      <StatBadge label="待确认" :value="totals.open" suffix="条" icon="WarningFilled" tone="danger" />
      <StatBadge label="已解决" :value="totals.resolved" suffix="条" icon="Grid" tone="success" />
      <StatBadge label="阻断级" :value="totals.blocking" suffix="条" icon="WarningFilled" tone="warning" />
      <StatBadge label="待重算（冻结）" :value="totals.stale" suffix="条" icon="RefreshRight" tone="danger" />
      <StatBadge label="已留档" :value="totals.archived" suffix="条" icon="FolderOpened" tone="info" />
    </div>

    <el-alert
      v-if="totals.stale > 0"
      class="stale-alert"
      type="warning"
      show-icon
      :closable="false"
      title="有现场记录 / 要素基准在白天镜次后被补记或更正"
    >
      <template #default>
        相关差异已标记「待重算」并冻结，旧结论不再参与统计；确认重算后旧结论留档并生成新一代差异，重算失败会自动恢复到动手前。
      </template>
    </el-alert>

    <FilterBar
      :model-value="store.filters"
      :selects="selects"
      keyword-placeholder="搜索要素 / 差异描述…"
      @update:model-value="onFilterChange"
      @reset="store.resetFilters()"
    />

    <EmptyPanel
      v-if="ready && filtered.length === 0"
      title="还没有差异条目"
      description="先在现场记录页为同一要素留下至少两次记录，然后点「重新比对生成差异」。"
      :show-create="false"
    />

    <el-table
      v-else
      :data="filtered"
      border
      stripe
      row-key="id"
      :row-class-name="rowClassName"
    >
      <el-table-column label="连戏要素" min-width="170">
        <template #default="{ row }">
          <div>{{ elementOf(row.elementId)?.name ?? '要素已删除' }}</div>
          <div class="muted">
            {{ elementOf(row.elementId)?.category ?? '—' }} ·
            {{ elementOf(row.elementId)?.critical ? '关键要素' : '一般要素' }}
          </div>
          <div class="muted">{{ sceneLabelOf(row.elementId) }}</div>
        </template>
      </el-table-column>
      <el-table-column label="记录 A（较早）" min-width="190">
        <template #default="{ row }">
          <div class="muted">
            {{ dayLabelOf(recordOf(row.recordIdA)) }} · 镜次 {{ recordOf(row.recordIdA)?.takeNo ?? '—' }}
            <el-tag v-if="recordOf(row.recordIdA)" size="small" effect="plain" round>v{{ row.recordAVersion }}</el-tag>
          </div>
          <div>{{ recordOf(row.recordIdA)?.currentState ?? '记录已删除' }}</div>
        </template>
      </el-table-column>
      <el-table-column label="记录 B（较晚）" min-width="190">
        <template #default="{ row }">
          <div class="muted">
            {{ dayLabelOf(recordOf(row.recordIdB)) }} · 镜次 {{ recordOf(row.recordIdB)?.takeNo ?? '—' }}
            <el-tag v-if="recordOf(row.recordIdB)" size="small" effect="plain" round>v{{ row.recordBVersion }}</el-tag>
          </div>
          <div>{{ recordOf(row.recordIdB)?.currentState ?? '记录已删除' }}</div>
        </template>
      </el-table-column>
      <el-table-column prop="diffDesc" label="差异描述" min-width="240" />
      <el-table-column label="严重程度 / 状态" width="170">
        <template #default="{ row }">
          <ConflictTag :severity="row.severity" :state="row.state" />
        </template>
      </el-table-column>
      <el-table-column label="版本链" width="150">
        <template #default="{ row }">
          <el-tooltip placement="top" :show-after="200">
            <template #content>
              <div>分组 {{ row.chainGroup }}</div>
              <div>依据记录 v{{ row.recordAVersion }} → v{{ row.recordBVersion }} · 基准 v{{ row.baselineVersion || '—' }}</div>
              <div v-if="row.supersededBy">已被新一代差异 {{ row.supersededBy }} 取代</div>
            </template>
            <el-tag size="small" effect="plain" round>第 {{ row.generation }} 代 · {{ chainOf(row).length }} 代同链</el-tag>
          </el-tooltip>
          <div v-if="row.state === '待重算'" class="stale-link" @click="confirmRecalc(row.elementId)">确认重算此要素 →</div>
        </template>
      </el-table-column>
      <el-table-column label="解决留痕" min-width="180">
        <template #default="{ row }">
          <template v-if="row.state === '已解决'">
            <div>{{ row.resolvedNote }}</div>
            <div class="muted">{{ row.resolvedAt ? row.resolvedAt.slice(0, 19).replace('T', ' ') : '' }}</div>
          </template>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="180" fixed="right">
        <template #default="{ row }">
          <el-button v-if="row.state === '待重算'" link type="danger" size="small" @click="confirmRecalc(row.elementId)">确认重算</el-button>
          <el-button v-if="row.state === '待确认'" link type="success" size="small" @click="resolve(row)">解决</el-button>
          <el-button v-if="row.state === '已解决'" link type="warning" size="small" @click="reopen(row)">重开</el-button>
          <el-button
            link
            :type="row.state === '已留档' ? 'info' : 'danger'"
            size="small"
            @click="remove(row)"
          >
            删除
          </el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<style scoped>
.stale-alert {
  margin-bottom: 12px;
}

.stale-link {
  margin-top: 4px;
  font-size: 12px;
  color: #c0392b;
  cursor: pointer;
}

.stale-link:hover {
  text-decoration: underline;
}

:deep(.row-archived) {
  color: #9aa5ad;
  background: #f6f8fa;
}
</style>
