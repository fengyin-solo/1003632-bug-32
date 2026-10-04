import { commit, getBlock, listRows, resetBlocks } from '@/data/local-store'
import { SEED_ROWS } from '@/data/seed'
import type {
  ActionResult,
  DutyReminder,
  EntryRow,
  HandoverRecord,
  PageResult,
} from '@/data/types'
import { filterRows } from './local-service'

// 值勤排班领域服务：
// 排班表（duty）是唯一事实源；交接记录（dutyHandovers）和检查站提醒（dutyReminders）
// 都是它的派生物，在同一次 commit 事务里落库，失败一起回退，三个视图永远不会各说各话。

const DUTY_KEY = 'duty'
const HANDOVER_KEY = 'dutyHandovers'
const REMINDER_KEY = 'dutyReminders'

export const DUTY_STATUSES = ['待确认', '已确认', '值勤中', '已调班', '已交接'] as const
export const HANDOVER_DONE = '已交接'
const MISSING_SUCCESSOR = '（历史未登记接班人）'

// 允许的状态推进：只准沿 待确认 → 已确认 → 值勤中 →（已调班分支）→ 已交接 单向走。
// 已交接是终态，没有任何出口；已调班离开后（进入值勤中/已交接）不能再回到已调班。
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  待确认: ['已确认', '已调班'],
  已确认: ['值勤中', '已调班'],
  值勤中: ['已交接', '已调班'],
  已调班: ['值勤中', '已交接'],
  已交接: [],
}

// 待交接提醒的派生口径：未到终态「已交接」的班次都还要被提醒/处理。
function isPending(row: EntryRow): boolean {
  return String(row.status) !== HANDOVER_DONE
}

function nowText(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function todayText(): string {
  return nowText().slice(0, 10)
}

function text(row: EntryRow, field: string): string {
  const value = row[field]
  return value === undefined || value === null ? '' : String(value).trim()
}

function reminderKind(status: string): string {
  switch (status) {
    case '待确认':
      return '待确认排班'
    case '已确认':
      return '待开始值勤'
    case '已调班':
      return '调班后待交接'
    default:
      return '待交接提醒'
  }
}

// 已登记的接班人（调班时填的）才算数；种子里的占位文本不算真实姓名，不能在交接时被当成接班人。
function registeredSuccessor(row: EntryRow): string {
  const value = text(row, '接班人员')
  return value && !value.startsWith('值勤排班样例') ? value : ''
}

// 为历史「已交接」但缺交接记录的班次补录一条历史记录；原值班日期保留，接班人不臆造。
function buildLegacyHandover(row: EntryRow, id: number): HandoverRecord {
  const dutyDate = text(row, '值勤日期')
  return {
    id,
    dutyId: Number(row.id),
    排班编号: text(row, '排班编号'),
    值勤日期: dutyDate,
    交班人: text(row, '值勤人员'),
    接班人: registeredSuccessor(row) || MISSING_SUCCESSOR,
    交接时间: dutyDate ? `${dutyDate} 00:00` : nowText(),
    交接说明: '历史交接数据补录，原值班日期保留',
  }
}

// 从排班表整量派生检查站提醒；提醒不允许单独编辑，保证刷新前后取数一致。
// 班次状态没变化的提醒沿用旧「更新时间」，只有真正变化（新出现/类型变更）才刷新时间，
// 这样每次动作重建的结果在无变化时与旧数据完全相等，不会产生多余写入。
function buildReminders(rows: EntryRow[], existing: DutyReminder[] = []): DutyReminder[] {
  let seq = 0
  return rows.filter(isPending).map((row) => {
    const kind = reminderKind(String(row.status))
    const prev = existing.find(
      (item) => item.dutyId === Number(row.id) && item.提醒类型 === kind,
    )
    return {
      id: (seq += 1),
      dutyId: Number(row.id),
      排班编号: text(row, '排班编号'),
      值勤日期: text(row, '值勤日期'),
      值勤时段: text(row, '值勤时段'),
      值勤岗位: text(row, '值勤岗位'),
      当前值勤人: text(row, '值勤人员'),
      提醒类型: kind,
      更新时间: prev ? prev.更新时间 : nowText(),
    }
  })
}

// 启动时的历史数据兼容迁移：
// 1. pending 以状态为准重算（旧版按状态位置机械计算，刷新后会把旧待交接标记带回来）；
// 2. 历史「已交接」但缺交接记录/接班人员的，补录历史交接记录，原值勤日期原样保留；
// 3. 交接记录与检查站提醒按当前排班整量重建，与排班同次落库。
// 迁移幂等：每次启动都可安全重跑，无变化不落库。
export function ensureDutyData(): void {
  const rows = listRows(DUTY_KEY).map((row) => ({ ...row }))
  const handovers = [...(getBlock<HandoverRecord[]>(HANDOVER_KEY) ?? [])]
  let rowsChanged = false

  for (const row of rows) {
    const expectedPending = isPending(row)
    let changed = row.pending !== expectedPending
    if (
      String(row.status) === HANDOVER_DONE &&
      !handovers.some((item) => item.dutyId === Number(row.id))
    ) {
      handovers.push(buildLegacyHandover(row, handovers.reduce((max, item) => Math.max(max, item.id), 0) + 1))
      changed = true
    }
    if (changed) {
      row.pending = expectedPending
      rowsChanged = true
    }
  }

  const reminders = buildReminders(rows, getBlock<DutyReminder[]>(REMINDER_KEY) ?? [])
  const handoversChanged =
    JSON.stringify(getBlock<HandoverRecord[]>(HANDOVER_KEY) ?? []) !== JSON.stringify(handovers)
  const remindersChanged =
    JSON.stringify(getBlock<DutyReminder[]>(REMINDER_KEY) ?? []) !== JSON.stringify(reminders)

  // 无任何差异就不写盘：旧标记已经在内存里被重算过（rows 是新对象），但持久层保持稳定。
  if (!rowsChanged && !handoversChanged && !remindersChanged) {
    return
  }

  // 派生块与排班同一次事务落库；写入失败由 commit 整体回退，不会出现只改了一半的状态。
  commit({
    [DUTY_KEY]: rows,
    [HANDOVER_KEY]: handovers,
    [REMINDER_KEY]: reminders,
  })
}

export function listDutyEntries(filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(DUTY_KEY), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function listHandoverRecords(): HandoverRecord[] {
  return [...(getBlock<HandoverRecord[]>(HANDOVER_KEY) ?? [])].sort((a, b) => b.id - a.id)
}

export function listCheckpointReminders(): DutyReminder[] {
  return getBlock<DutyReminder[]>(REMINDER_KEY) ?? []
}

export function dutyStats(): { label: string; value: number }[] {
  const rows = listRows(DUTY_KEY)
  const today = todayText()
  return [
    {
      label: '今日值勤人数',
      value: rows.filter(
        (row) =>
          text(row, '值勤日期') === today &&
          ['已确认', '值勤中', '已调班'].includes(String(row.status)),
      ).length,
    },
    {
      label: '待交接次数',
      value: rows.filter((row) => ['值勤中', '已调班'].includes(String(row.status))).length,
    },
    {
      label: '调班申请数',
      value: rows.filter((row) => String(row.status) === '已调班').length,
    },
  ]
}

function findDutyRow(rows: EntryRow[], id: number): EntryRow | undefined {
  return rows.find((row) => Number(row.id) === id)
}

function guardTransition(current: string, target: string): ActionResult | null {
  if (!ALLOWED_TRANSITIONS[current]) {
    return { ok: false, message: `排班状态「${current}」不在值勤生命周期内，请先修正数据` }
  }
  if (!ALLOWED_TRANSITIONS[current].includes(target)) {
    if (current === HANDOVER_DONE) {
      return { ok: false, message: '该班次已交接，状态已到终态，不能再操作' }
    }
    return {
      ok: false,
      message: `「${current}」不能流转到「${target}」，排班只能沿待确认到已交接单向推进`,
    }
  }
  return null
}

// 所有写操作共用的落库口径：改排班 →（可选）追加交接记录 → 整量重建提醒，一次事务提交。
function persist(rows: EntryRow[], handovers: HandoverRecord[]): void {
  commit({
    [DUTY_KEY]: rows,
    [HANDOVER_KEY]: handovers,
    [REMINDER_KEY]: buildReminders(rows, getBlock<DutyReminder[]>(REMINDER_KEY) ?? []),
  })
}

// commit 失败已把缓存与存储整体回退，这里把异常收敛成 ActionResult，页面统一按失败提示处理。
function safePersist(rows: EntryRow[], handovers: HandoverRecord[], action: string): ActionResult | null {
  try {
    persist(rows, handovers)
    return null
  } catch (error) {
    const reason = error instanceof Error ? error.message : '未知写入错误'
    return { ok: false, message: `${action}失败，排班、交接记录与提醒已一起回退：${reason}` }
  }
}

export function confirmDuty(id: number): ActionResult {
  const rows = listRows(DUTY_KEY)
  const row = findDutyRow(rows, id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的值勤排班` }
  }
  const current = String(row.status)
  if (current === '已确认') {
    return { ok: true, message: '该排班已确认，无需重复确认' }
  }
  const blocked = guardTransition(current, '已确认')
  if (blocked) {
    return blocked
  }
  const next = [...rows]
  next[next.indexOf(row)] = { ...row, status: '已确认', pending: true }
  const failed = safePersist(next, getBlock<HandoverRecord[]>(HANDOVER_KEY) ?? [], '确认排班')
  if (failed) {
    return failed
  }
  return { ok: true, message: '排班已确认，等待开始值勤' }
}

export function startDuty(id: number): ActionResult {
  const rows = listRows(DUTY_KEY)
  const row = findDutyRow(rows, id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的值勤排班` }
  }
  const current = String(row.status)
  if (current === '值勤中') {
    return { ok: true, message: '该班次已在值勤中' }
  }
  const blocked = guardTransition(current, '值勤中')
  if (blocked) {
    return blocked
  }
  const next = [...rows]
  next[next.indexOf(row)] = { ...row, status: '值勤中', pending: true }
  const failed = safePersist(next, getBlock<HandoverRecord[]>(HANDOVER_KEY) ?? [], '开始值勤')
  if (failed) {
    return failed
  }
  return { ok: true, message: '班次已开始值勤' }
}

// 申请调班：必须登记接班人员；已在「已调班」时再次申请可以换人（接班人同步更新）；已交接一律拒绝。
export function applySwap(id: number, successor: string): ActionResult {
  const name = successor.trim()
  if (!name) {
    return { ok: false, message: '申请调班必须登记接班人员' }
  }
  const rows = listRows(DUTY_KEY)
  const row = findDutyRow(rows, id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的值勤排班` }
  }
  const current = String(row.status)
  if (current === '已调班' && text(row, '接班人员') === name) {
    // 重复调班幂等：同一接班人不重复落记录、不改状态。
    return { ok: true, message: `调班申请已存在，接班人员仍为「${name}」` }
  }
  if (current !== '已调班') {
    const blocked = guardTransition(current, '已调班')
    if (blocked) {
      return blocked
    }
  }
  const next = [...rows]
  next[next.indexOf(row)] = { ...row, status: '已调班', pending: true, 接班人员: name }
  const failed = safePersist(next, getBlock<HandoverRecord[]>(HANDOVER_KEY) ?? [], '申请调班')
  if (failed) {
    return failed
  }
  return {
    ok: true,
    message:
      current === '已调班'
        ? `已更新接班人员为「${name}」，等待接班后交接`
        : `调班申请已登记，接班人员「${name}」，等待接班后交接`,
  }
}

// 记录交接：只允许从 值勤中 / 已调班 推进到 已交接；对已交接班次重复提交幂等，不重复生成记录。
// 值勤日期全程不改动。
export function recordHandover(id: number, successor: string, note: string): ActionResult {
  const rows = listRows(DUTY_KEY)
  const row = findDutyRow(rows, id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的值勤排班` }
  }
  const handovers = [...(getBlock<HandoverRecord[]>(HANDOVER_KEY) ?? [])]
  const current = String(row.status)
  if (current === HANDOVER_DONE) {
    // 重复交接幂等：已有交接记录直接返回成功，不再追加。
    const existing = handovers.find((item) => item.dutyId === id)
    return {
      ok: true,
      message: existing
        ? `该班次已由「${existing.接班人}」接班，交接记录无需重复登记`
        : '该班次已交接，交接记录无需重复登记',
    }
  }
  const blocked = guardTransition(current, HANDOVER_DONE)
  if (blocked) {
    return blocked
  }
  const name = successor.trim()
  const time = nowText()
  const record: HandoverRecord = {
    id: handovers.reduce((max, item) => Math.max(max, item.id), 0) + 1,
    dutyId: id,
    排班编号: text(row, '排班编号'),
    值勤日期: text(row, '值勤日期'),
    交班人: text(row, '值勤人员'),
    接班人: name || registeredSuccessor(row) || MISSING_SUCCESSOR,
    交接时间: time,
    交接说明: note.trim() || (name ? `${name}接班，交接完成` : '交接完成，接班人员待补登'),
  }
  handovers.push(record)

  const updated: EntryRow = {
    ...row,
    status: HANDOVER_DONE,
    pending: false,
    // 未填接班人时沿用调班已登记的接班人；都没有则留空待补登，不能把种子占位文本写进去。
    接班人员: name || registeredSuccessor(row),
    交接记录: `${record.接班人} 已于 ${time} 接班`,
  }
  const next = [...rows]
  next[next.indexOf(row)] = updated
  // 排班、交接记录、提醒一次落库；失败时 commit 已把三块全部回退，并在这里收敛为失败结果。
  const failed = safePersist(next, handovers, '记录交接')
  if (failed) {
    return failed
  }
  return { ok: true, message: `交接完成：${record.接班人} 已于 ${time} 接班（值勤日期 ${record.值勤日期} 保持不变）` }
}

// 重置值勤模块：排班回示例数据，交接记录与提醒按示例数据整量重建，仍在同一事务内。
export function resetDuty(): PageResult {
  const seedRows = (JSON.parse(JSON.stringify(SEED_ROWS[DUTY_KEY] ?? [])) as EntryRow[]).map(
    (row) => ({ ...row, pending: isPending(row) }),
  )
  const handovers = seedRows
    .filter((row) => String(row.status) === HANDOVER_DONE)
    .map((row, index) => buildLegacyHandover(row, index + 1))
  resetBlocks({
    [DUTY_KEY]: seedRows,
    [HANDOVER_KEY]: handovers,
    [REMINDER_KEY]: buildReminders(seedRows),
  })
  return listDutyEntries()
}
