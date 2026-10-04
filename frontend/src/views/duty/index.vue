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
          <td v-for="column in columns" :key="column">{{ displayCell(row, column) }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <template v-if="actionsFor(row).length">
              <button
                v-for="action in actionsFor(row)"
                :key="action"
                class="link"
                type="button"
                @click="dispatch(action, row)"
              >
                {{ action }}
              </button>
            </template>
            <span v-else class="done-text">已闭环</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无值勤排班数据，可先登记值勤排班表</td>
        </tr>
      </tbody>
    </table>

    <section class="handover-panel">
      <h3>交接面板</h3>
      <p class="panel-hint">交接记录只随「记录交接」生成，重复提交幂等不重复登记；原值班日期保留。</p>
      <table class="data-table">
        <thead>
          <tr>
            <th>排班编号</th><th>值勤日期</th><th>交班人</th><th>接班人</th><th>交接时间</th><th>交接说明</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="record in handoverRecords" :key="record.id">
            <td>{{ record.排班编号 }}</td>
            <td>{{ record.值勤日期 || '—' }}</td>
            <td>{{ record.交班人 || '—' }}</td>
            <td>{{ record.接班人 }}</td>
            <td>{{ record.交接时间 }}</td>
            <td>{{ record.交接说明 }}</td>
          </tr>
          <tr v-if="!handoverRecords.length">
            <td colspan="6" class="empty-state">暂无交接记录</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条值勤排班记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 调班弹窗：接班人必填，已调班时再打开即换人 -->
    <div v-if="swapDialog.open" class="modal-mask" @click.self="closeDialogs">
      <div class="modal-card">
        <h3>申请调班</h3>
        <p class="panel-hint">排班 {{ swapDialog.code }} · 原值勤日期 {{ swapDialog.date }} 保持不变</p>
        <label class="dialog-field">
          <span>接班人员 *</span>
          <input v-model="swapDialog.successor" placeholder="请输入接班人员姓名" />
        </label>
        <p v-if="swapDialog.error" class="error-text">{{ swapDialog.error }}</p>
        <div class="dialog-actions">
          <button class="btn ghost" type="button" @click="closeDialogs">取消</button>
          <button class="btn primary" type="button" @click="submitSwap">提交调班</button>
        </div>
      </div>
    </div>

    <!-- 交接弹窗：接班人为空时允许提交，按「历史未登记」兼容，但必须来自值勤中/已调班 -->
    <div v-if="handoverDialog.open" class="modal-mask" @click.self="closeDialogs">
      <div class="modal-card">
        <h3>记录交接</h3>
        <p class="panel-hint">排班 {{ handoverDialog.code }} · 交班人 {{ handoverDialog.from }} · 值勤日期 {{ handoverDialog.date }} 保留</p>
        <label class="dialog-field">
          <span>接班人员</span>
          <input v-model="handoverDialog.successor" placeholder="历史记录可留空，留空将标记为待补登" />
        </label>
        <label class="dialog-field">
          <span>交接说明</span>
          <textarea v-model="handoverDialog.note" rows="3" placeholder="装备、钥匙、注意事项等"></textarea>
        </label>
        <p v-if="handoverDialog.error" class="error-text">{{ handoverDialog.error }}</p>
        <div class="dialog-actions">
          <button class="btn ghost" type="button" @click="closeDialogs">取消</button>
          <button class="btn primary" type="button" @click="submitHandover">确认交接</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  applySwap,
  confirmDuty,
  dutyStats,
  listDutyEntries,
  listHandoverRecords,
  recordHandover,
  startDuty,
} from '@/api/duty-service'
import {
  downloadEntries,
  moduleMeta,
} from '@/api/local-service'
import type { EntryRow, HandoverRecord } from '@/data/types'

const meta = moduleMeta('duty')
// 排班状态有独立的「当前状态」列，数据列不再重复展示示例里的占位字段。
const columns = ["排班编号", "值勤日期", "值勤时段", "值勤岗位", "值勤人员", "接班人员", "交接记录"]
const statuses = ["待确认", "已确认", "值勤中", "已调班", "已交接"]

// 每个状态只给生命周期内允许的动作：待确认 → 已确认 → 值勤中 →（已调班）→ 已交接，终态无动作。
const ACTIONS_BY_STATUS: Record<string, string[]> = {
  待确认: ['确认排班', '申请调班'],
  已确认: ['开始值勤', '申请调班'],
  值勤中: ['记录交接', '申请调班'],
  已调班: ['开始值勤', '记录交接', '申请调班'],
  已交接: [],
}

const rows = ref<EntryRow[]>([])
const total = ref(0)
const stats = ref(dutyStats())
const handoverRecords = ref<HandoverRecord[]>([])
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ["排班编号", "值勤日期", "值勤时段"]

const PLACEHOLDER_PREFIX = '值勤排班样例'

function swapSuccessor(row: EntryRow): string {
  const value = String(row['接班人员'] ?? '').trim()
  return value.startsWith(PLACEHOLDER_PREFIX) ? '' : value
}

function displayCell(row: EntryRow, column: string): string {
  const value = String(row[column] ?? '').trim()
  if (!value) {
    return '—'
  }
  // 示例数据里的占位文本统一不展示为真实业务内容。
  if (value.startsWith(PLACEHOLDER_PREFIX)) {
    return '—'
  }
  return value
}

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const swapDialog = ref<{
  open: boolean
  id: number
  code: string
  date: string
  successor: string
  error: string
}>({ open: false, id: 0, code: '', date: '', successor: '', error: '' })

const handoverDialog = ref<{
  open: boolean
  id: number
  code: string
  date: string
  from: string
  successor: string
  note: string
  error: string
}>({ open: false, id: 0, code: '', date: '', from: '', successor: '', note: '', error: '' })

function actionsFor(row: EntryRow): string[] {
  return ACTIONS_BY_STATUS[String(row.status)] ?? []
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

function closeDialogs() {
  swapDialog.value.open = false
  handoverDialog.value.open = false
}

function dispatch(action: string, row: EntryRow) {
  errorMessage.value = ''
  const id = Number(row.id)
  if (action === '确认排班') {
    finish(confirmDuty(id))
    return
  }
  if (action === '开始值勤') {
    finish(startDuty(id))
    return
  }
  if (action === '申请调班') {
    swapDialog.value = {
      open: true,
      id,
      code: String(row['排班编号'] ?? ''),
      date: String(row['值勤日期'] ?? ''),
      successor: swapSuccessor(row),
      error: '',
    }
    return
  }
  if (action === '记录交接') {
    handoverDialog.value = {
      open: true,
      id,
      code: String(row['排班编号'] ?? ''),
      date: String(row['值勤日期'] ?? ''),
      from: String(row['值勤人员'] ?? ''),
      successor: swapSuccessor(row),
      note: '',
      error: '',
    }
  }
}

function submitSwap() {
  const result = applySwap(swapDialog.value.id, swapDialog.value.successor)
  if (!result.ok) {
    swapDialog.value.error = result.message
    return
  }
  closeDialogs()
  finish(result)
}

function submitHandover() {
  const result = recordHandover(
    handoverDialog.value.id,
    handoverDialog.value.successor,
    handoverDialog.value.note,
  )
  if (!result.ok) {
    handoverDialog.value.error = result.message
    return
  }
  closeDialogs()
  finish(result)
}

function finish(result: { ok: boolean; message: string }) {
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listDutyEntries(filters.value)
    rows.value = payload.items
    total.value = payload.total
    stats.value = dutyStats()
    handoverRecords.value = listHandoverRecords()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '值勤排班列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.handover-panel {
  margin-top: 18px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
}
.handover-panel h3 { margin: 0 0 4px; font-size: 15px; }
.panel-hint { margin: 0 0 8px; font-size: 12px; color: var(--muted); }
.done-text { color: var(--muted); font-size: 12px; }
.modal-mask {
  position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45);
  display: flex; align-items: center; justify-content: center; z-index: 20;
}
.modal-card {
  width: 420px; background: #fff; border-radius: 10px; padding: 18px 20px;
}
.modal-card h3 { margin: 0 0 6px; font-size: 16px; }
.dialog-field { display: block; margin-bottom: 10px; }
.dialog-field span { display: block; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
.dialog-field input, .dialog-field textarea {
  width: 100%; border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; font: inherit;
}
.dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
</style>
