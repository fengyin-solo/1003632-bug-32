<template>
  <section class="page" data-module="duty">
    <header class="page-head">
      <div>
        <h2>值勤排班管理</h2>
        <p class="page-desc">维护值勤排班表，围绕排班编号、值勤日期、值勤时段、值勤岗位做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记值勤排班表</button>
        <button class="btn" type="button" @click="exportRows">导出值勤排班清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <!-- 交接面板：待交接队列与已交接记录都直接取排班这一个数据源，跟列表、检查站提醒同源 -->
    <div class="handover-panel">
      <article class="handover-col">
        <h3>待交接队列</h3>
        <table class="data-table compact" v-if="pendingQueue.length">
          <thead>
            <tr><th>排班编号</th><th>值勤日期</th><th>值勤岗位</th><th>值勤人员</th><th>接班人员</th><th>操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in pendingQueue" :key="`pending-${String(row.id)}`">
              <td>{{ row['排班编号'] }}</td>
              <td>{{ row['值勤日期'] }}</td>
              <td>{{ row['值勤岗位'] }}</td>
              <td>{{ row['值勤人员'] }}</td>
              <td>{{ hasSuccessor(row) ? row['接班人员'] : '尚未指派' }}</td>
              <td class="row-actions">
                <button class="link" type="button" @click="openDialog('记录交接', row)">到站确认交接</button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="empty-inline">暂无待交接班次</p>
      </article>
      <article class="handover-col">
        <h3>已交接记录</h3>
        <table class="data-table compact" v-if="history.length">
          <thead>
            <tr><th>排班编号</th><th>值勤日期</th><th>值勤岗位</th><th>接班人员</th><th>交接记录</th></tr>
          </thead>
          <tbody>
            <tr v-for="item in history" :key="`history-${item.id}`">
              <td>{{ item.排班编号 }}</td>
              <td>{{ item.值勤日期 }}</td>
              <td>{{ item.值勤岗位 }}</td>
              <td>{{ item.接班人员 }}</td>
              <td>{{ item.交接记录 }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="empty-inline">暂无已交接记录</p>
      </article>
    </div>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <template v-if="availableActions(row).length">
              <button
                v-for="action in availableActions(row)"
                :key="action"
                class="link"
                type="button"
                @click="dispatchAction(action, row)"
              >
                {{ action }}
              </button>
            </template>
            <span v-else class="muted">已交接，终态不可再操作</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无值勤排班数据，可先登记值勤排班表</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条值勤排班记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="dialog.open" class="modal-mask" @click.self="closeDialog">
      <form class="modal-card" @submit.prevent="confirmDialog">
        <h3>{{ dialog.action }} · {{ String(dialog.row?.['排班编号'] ?? '') }}</h3>
        <p class="muted">
          值勤日期 {{ String(dialog.row?.['值勤日期'] ?? '') }} 保持不变，状态只能沿
          待确认 → 已确认 → 值勤中 → 已交接 单向推进。
        </p>
        <label class="filter-item">
          <span>接班人员{{ dialog.action === '申请调班' ? '（必填）' : '' }}</span>
          <input v-model="dialog.successor" placeholder="请输入接班人员姓名" />
        </label>
        <label class="filter-item">
          <span>交接说明</span>
          <input v-model="dialog.note" placeholder="可补充到站确认情况，选填" />
        </label>
        <p v-if="dialog.error" class="error-text">{{ dialog.error }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeDialog">取消</button>
          <button class="btn primary" type="submit">确认</button>
        </div>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  HANDED_OVER,
  listDutyRows,
  listHandoverHistory,
  listHandoverReminders,
  loadDutyStats,
  runDutyAction,
} from '@/api/duty-service'
import { listRows } from '@/data/local-store'
import { downloadEntries, moduleMeta } from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('duty')
const columns = ['排班编号', '值勤日期', '值勤时段', '值勤岗位', '值勤人员', '接班人员', '交接记录', '排班状态']
const statuses = ['待确认', '已确认', '值勤中', '已交接', '已调班']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const stats = ref([
  { label: '今日值勤人数', value: 0 },
  { label: '待交接次数', value: 0 },
  { label: '调班申请数', value: 0 },
])
const history = ref(listHandoverHistory())
const reminders = ref<EntryRow[]>([])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 待交接队列由「检查站提醒」派生数据驱动，而提醒本身又由排班派生，三处看到的是同一事实。
// 用未筛选的完整排班行做关联，避免列表筛选条件把交接队列也过滤掉。
const pendingQueue = computed(() =>
  reminders.value
    .map((reminder) =>
      listRows('duty').find((row) => Number(row.id) === Number(reminder.id)),
    )
    .filter((row): row is EntryRow => Boolean(row)),
)

const dialog = reactive({
  open: false,
  action: '记录交接' as '记录交接' | '申请调班',
  row: null as EntryRow | null,
  successor: '',
  note: '',
  error: '',
})

function hasSuccessor(row: EntryRow): boolean {
  const value = String(row['接班人员'] ?? '').trim()
  return value !== '' && value !== '历史记录未登记'
}

// 已交接不再出现任何动作按钮，杜绝重复交接入口；各状态只暴露合法的单向推进动作。
function availableActions(row: EntryRow): string[] {
  switch (String(row.status)) {
    case '待确认':
      return ['确认排班']
    case '已确认':
      return ['开始值勤', '申请调班', '记录交接']
    case '值勤中':
      return ['记录交接', '申请调班']
    case '已调班':
      return ['记录交接']
    case HANDED_OVER:
    default:
      return []
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '值勤排班表登记入口尚未接入审批流'
}

function dispatchAction(action: string, row: EntryRow) {
  if (action === '记录交接' || action === '申请调班') {
    openDialog(action, row)
    return
  }
  applyResult(runDutyAction(action as '确认排班' | '开始值勤', Number(row.id)))
}

function openDialog(action: '记录交接' | '申请调班', row: EntryRow) {
  dialog.open = true
  dialog.action = action
  dialog.row = row
  dialog.successor = hasSuccessor(row) ? String(row['接班人员']) : ''
  dialog.note = ''
  dialog.error = ''
}

function closeDialog() {
  dialog.open = false
  dialog.row = null
  dialog.error = ''
}

function confirmDialog() {
  if (!dialog.row) {
    return
  }
  const result = runDutyAction(dialog.action, Number(dialog.row.id), {
    successor: dialog.successor,
    note: dialog.note,
  })
  if (!result.ok) {
    dialog.error = result.message
    return
  }
  closeDialog()
  applyResult(result)
}

function applyResult(result: { ok: boolean; message: string }) {
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  errorMessage.value = ''
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    rows.value = listDutyRows(filters.value)
    total.value = rows.value.length
    reminders.value = listHandoverReminders()
    history.value = listHandoverHistory()
    const dutyStats = loadDutyStats()
    stats.value = [
      { label: '今日值勤人数', value: dutyStats.todayOnDuty },
      { label: '待交接次数', value: dutyStats.pendingHandover },
      { label: '调班申请数', value: dutyStats.swapApplied },
    ]
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '值勤排班列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.handover-panel {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
  gap: 16px;
  margin-bottom: 16px;
}

.handover-col {
  border: 1px solid var(--border-color, #d8dee6);
  border-radius: 8px;
  padding: 12px 14px;
  background: #fff;
}

.handover-col h3 {
  margin: 0 0 8px;
  font-size: 15px;
}

.data-table.compact {
  font-size: 13px;
}

.empty-inline {
  margin: 8px 0;
  color: #8a94a6;
}

.muted {
  color: #8a94a6;
}

.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
}

.modal-card {
  width: min(420px, 92vw);
  background: #fff;
  border-radius: 10px;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.modal-card h3 {
  margin: 0;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
