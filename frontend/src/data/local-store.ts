import { MODULE_BY_KEY } from './modules'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'forest-fire-patrol:entries'
// 历史已交接但没登记接班人员的记录，迁移时补这个占位，原值勤日期等字段一律不动。
export const LEGACY_SUCCESSOR = '历史记录未登记'
// 检查站提醒不在业务模块表里，它是值勤排班的派生数据，单独存一个 key。
export const REMINDER_KEY = 'checkpoint-reminders'
const DUTY_KEY = 'duty'
const HANDED_OVER = '已交接'

// 与 api/duty-service.ts 的阶段表保持一致：已调班是旁支，跟值勤中同阶段；已交接才是终态。
const DUTY_STAGE: Record<string, number> = {
  待确认: 0,
  已确认: 1,
  值勤中: 2,
  已调班: 2,
  已交接: 3,
}

function dutyPending(status: string): boolean {
  return status !== HANDED_OVER
}

// v1：直接存模块数组；v2：带版本号的快照，刷新时按版本迁移，旧标记不会原样复活。
const CURRENT_VERSION = 2

type Snapshot = {
  version: number
  entries: Record<string, EntryRow[]>
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isV1Snapshot(value: unknown): value is Record<string, EntryRow[]> {
  return typeof value === 'object' && value !== null && !('version' in value)
}

// pending 一律由「当前状态是不是该模块终态」派生，不能再信任历史数组里存的旧标记。
function derivePending(key: string, row: EntryRow): boolean {
  if (key === REMINDER_KEY) {
    return row.pending === true
  }
  const meta = MODULE_BY_KEY.get(key)
  if (!meta || meta.statuses.length === 0) {
    return row.pending === true
  }
  return String(row.status) !== meta.statuses[meta.statuses.length - 1]
}

// 历史值勤记录兼容：已交接但缺接班人员的补登记，交接记录缺失的补说明；
// 只补缺字段，值勤日期、时段等原值一律保留。
function migrateDutyRows(rows: EntryRow[]): EntryRow[] {
  return rows.map((row) => {
    const next: EntryRow = { ...row }
    const status = String(next.status)
    const successor = String(next['接班人员'] ?? '').trim()
    const handoverNote = String(next['交接记录'] ?? '').trim()
    // 值勤流程没有「撤销/驳回」类负向动作，abnormal 一律归位，避免旧数据的脏标记带到新视图。
    next.abnormal = false
    if (status === HANDED_OVER) {
      if (!successor) {
        next['接班人员'] = LEGACY_SUCCESSOR
      }
      if (!handoverNote) {
        next['交接记录'] = '历史交接（原记录未登记接班人与交接说明）'
      }
    }
    next.pending = dutyPending(status)
    return next
  })
}

function normalizeEntries(entries: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  const normalized: Record<string, EntryRow[]> = {}
  for (const [key, rows] of Object.entries(entries)) {
    if (!Array.isArray(rows)) {
      continue
    }
    // duty 的 pending 由迁移函数按交接终态设置，不能走通用「meta 末态」判断
    //（duty 末态声明为已调班，会把已交接误判回待交接）。
    if (key === DUTY_KEY) {
      normalized[key] = migrateDutyRows(rows)
      continue
    }
    normalized[key] = rows.map((row) => ({ ...row, pending: derivePending(key, row) }))
  }
  return normalized
}

// 提醒由排班数据派生：未到「已交接」终态的已确认班次都要提醒检查站准备交接。
// 放在持久化层是因为它必须与排班同快照落库；派生源始终是 duty，提醒自身不允许手工改。
function rebuildReminders(entries: Record<string, EntryRow[]>): EntryRow[] {
  const dutyRows = entries[DUTY_KEY] ?? []
  return dutyRows
    .filter((row) => {
      const rank = DUTY_STAGE[String(row.status)] ?? -1
      return rank >= DUTY_STAGE['已确认'] && rank < DUTY_STAGE[HANDED_OVER]
    })
    .map((row) => {
      const successor = String(row['接班人员'] ?? '').trim()
      const post = String(row['值勤岗位'] ?? '—')
      const onDuty = String(row['值勤人员'] ?? '—')
      const nextShift = successor && successor !== LEGACY_SUCCESSOR ? successor : '尚未指派'
      return {
        id: Number(row.id),
        status: '待交接',
        pending: true,
        abnormal: false,
        kind: 'duty-handover',
        排班编号: row['排班编号'] ?? '',
        值勤日期: row['值勤日期'] ?? '',
        值班日期: row['值勤日期'] ?? '',
        值勤岗位: post,
        值勤人员: onDuty,
        接班人员: successor,
        提醒内容: `「${post}」${onDuty} 的班次待交接，请接班人 ${nextShift} 到站确认`,
      } satisfies EntryRow
    })
}

function migrate(raw: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  // 先补齐各模块的示例数据兜底，再做规范化，最后由排班重算检查站提醒。
  const entries = normalizeEntries({ ...clone(SEED_ROWS), ...raw })
  entries[REMINDER_KEY] = rebuildReminders(entries)
  return entries
}

function persist(entries: Record<string, EntryRow[]>): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  const snapshot: Snapshot = { version: CURRENT_VERSION, entries }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return migrate(fallback)
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seeded = migrate(fallback)
    persist(seeded)
    return seeded
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    const seeded = migrate(fallback)
    persist(seeded)
    return seeded
  }
  // v1 存的是裸模块映射，v2 起是 { version, entries }，统一按版本迁移。
  const legacyEntries = isV1Snapshot(parsed) ? parsed : (parsed as Snapshot).entries
  const entries = migrate(legacyEntries ?? {})
  persist(entries)
  return entries
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

// 事务提交：调用方先把要改的多个 key（排班 + 提醒）一次传进来，
// 先在内存里组装完整快照并序列化，最后只写一次盘；写盘抛错时旧缓存原样保留，等于整体回退。
export function commitRows(patch: Record<string, EntryRow[]>): void {
  const current = allRows()
  const next = { ...current, ...patch }
  const snapshot: Snapshot = { version: CURRENT_VERSION, entries: next }
  const serialized = JSON.stringify(snapshot)
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, serialized)
  }
  cache = next
}

export function saveRows(key: string, rows: EntryRow[]): void {
  commitRows({ [key]: rows })
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  if (key === DUTY_KEY) {
    const entries = { ...allRows(), [key]: rows }
    commitRows({ [key]: migrateDutyRows(rows), [REMINDER_KEY]: rebuildReminders(entries) })
  } else {
    saveRows(key, rows)
  }
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
