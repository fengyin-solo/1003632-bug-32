<template>
  <section class="page" data-module="checkpoint">
    <header class="page-head">
      <div>
        <h2>防火检查站管理</h2>
        <p class="page-desc">维护防火检查站，围绕站点编号、站点位置、值守人员、检查项目做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记防火检查站</button>
        <button class="btn" type="button" @click="exportRows">导出防火检查站清单</button>
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
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无防火检查站数据，可先登记防火检查站</td>
        </tr>
      </tbody>
    </table>

    <section class="reminder-panel">
      <h3>检查站提醒 · 值勤待交接</h3>
      <p class="panel-hint">提醒直接取自值勤排班的待交接班次，与排班、交接记录同次落库；交接完成后提醒即消失。</p>
      <table class="data-table">
        <thead>
          <tr>
            <th>排班编号</th><th>值勤日期</th><th>值勤时段</th><th>值勤岗位</th><th>当前值勤人</th><th>提醒类型</th><th>更新时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in reminders" :key="item.dutyId">
            <td>{{ item.排班编号 }}</td>
            <td>{{ item.值勤日期 || '—' }}</td>
            <td>{{ item.值勤时段 }}</td>
            <td>{{ item.值勤岗位 }}</td>
            <td>{{ item.当前值勤人 }}</td>
            <td>{{ item.提醒类型 }}</td>
            <td>{{ item.更新时间 }}</td>
          </tr>
          <tr v-if="!reminders.length">
            <td colspan="7" class="empty-state">暂无待交接提醒</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条防火检查站记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { listCheckpointReminders } from '@/api/duty-service'
import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { DutyReminder, EntryRow } from '@/data/types'

const meta = moduleMeta('checkpoint')
const columns = ["站点编号", "站点位置", "值守人员", "检查项目", "通行车辆数", "收缴火种数", "值班日期", "运行状态"]
const actions = ["升级检查", "关闭站点", "安排换岗"]
const statuses = ["正常检查", "临时关闭", "升级检查", "等待换岗"]
const stats = [{"label": "站点总数", "value": 0}, {"label": "正常检查数", "value": 0}, {"label": "收缴火种数", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const reminders = ref<DutyReminder[]>([])
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '防火检查站登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    reminders.value = listCheckpointReminders()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '防火检查站列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.reminder-panel {
  margin-top: 18px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
}
.reminder-panel h3 { margin: 0 0 4px; font-size: 15px; }
.panel-hint { margin: 0 0 8px; font-size: 12px; color: var(--muted); }
</style>
