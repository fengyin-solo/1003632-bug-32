import {
  commitRows,
  LEGACY_SUCCESSOR,
  listRows,
  REMINDER_KEY,
} from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 值勤排班领域服务：排班状态、交接记录、检查站提醒三处的数据都从这里走，
// 保证单一事实源、单向生命周期、交接幂等，以及排班与提醒同事务落库。

const DUTY_KEY = 'duty'

// 生命周期：待确认 → 已确认 → 值勤中 → 已交接。
// 已调班是已确认/值勤中之后的旁支（与值勤中同阶段），仍可继续推进到已交接；
// 已交接是终态，任何操作都不能回退。
export const DUTY_STATUSES = ['待确认', '已确认', '值勤中', '已交接', '已调班'] as const
export const HANDED_OVER = '已交接'

// 阶段表比状态数组下标更准：已调班是旁支，跟值勤中同阶段；已交接单独是终态。
const STAGE: Record<string, number> = {
  待确认: 0,
  已确认: 1,
  值勤中: 2,
  已调班: 2,
  已交接: 3,
}

export type DutyStats = {
  todayOnDuty: number
  pendingHandover: number
  swapApplied: number
}

export type DutyHistoryItem = {
  id: number
  排班编号: string
  值勤日期: string
  值勤岗位: string
  接班人员: string
  交接记录: string
}

export type DutyActionInput = {
  successor?: string
  note?: string
  at?: string
}

export type DutyActionResult = ActionResult & { idempotent?: boolean }

export function listDutyRows(filters: Record<string, string> = {}): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  return listRows(DUTY_KEY).filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listHandoverReminders(): EntryRow[] {
  return listRows(REMINDER_KEY)
}

function statusRank(status: string): number {
  return STAGE[status] ?? -1
}

function isTerminal(rank: number): boolean {
  return rank === STAGE[HANDED_OVER]
}

function isMissingSuccessor(value: unknown): boolean {
  const text = String(value ?? '').trim()
  return text === '' || text === LEGACY_SUCCESSOR
}

// 「记录交接」允许从已确认/值勤中/已调班进入已交接（已调班是旁支，不是回退）。
function canHandover(rank: number): boolean {
  return rank >= STAGE['已确认'] && rank < STAGE[HANDED_OVER]
}

function appendNote(existing: unknown, note: string): string {
  const text = String(existing ?? '').trim()
  return text ? `${text}｜${note}` : note
}

export function todayLabel(): string {
  return new Date().toISOString().slice(0, 10)
}

export function loadDutyStats(today: string = todayLabel()): DutyStats {
  const rows = listRows(DUTY_KEY)
  return {
    todayOnDuty: rows.filter(
      (row) => String(row['值勤日期']) === today && String(row.status) === '值勤中',
    ).length,
    pendingHandover: rows.filter((row) => {
      const rank = statusRank(String(row.status))
      return rank >= STAGE['已确认'] && rank < STAGE[HANDED_OVER]
    }).length,
    swapApplied: rows.filter((row) => String(row.status) === '已调班').length,
  }
}

export function listHandoverHistory(): DutyHistoryItem[] {
  return listRows(DUTY_KEY)
    .filter((row) => String(row.status) === HANDED_OVER)
    .map((row) => ({
      id: Number(row.id),
      排班编号: String(row['排班编号'] ?? ''),
      值勤日期: String(row['值勤日期'] ?? ''),
      值勤岗位: String(row['值勤岗位'] ?? ''),
      接班人员: String(row['接班人员'] ?? LEGACY_SUCCESSOR),
      交接记录: String(row['交接记录'] ?? ''),
    }))
}

// 提醒由排班数据派生：未到「已交接」终态的已确认/值勤中/已调班班次都要提醒检查站准备交接。
function deriveReminders(dutyRows: EntryRow[]): EntryRow[] {
  return dutyRows
    .filter((row) => {
      const rank = statusRank(String(row.status))
      return rank >= STAGE['已确认'] && rank < STAGE[HANDED_OVER]
    })
    .map((row) => {
      const successorValue = String(row['接班人员'] ?? '').trim()
      const post = String(row['值勤岗位'] ?? '—')
      const onDuty = String(row['值勤人员'] ?? '—')
      const nextShift =
        successorValue && successorValue !== LEGACY_SUCCESSOR ? successorValue : '尚未指派'
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
        接班人员: successorValue,
        提醒内容: `「${post}」${onDuty} 的班次待交接，请接班人 ${nextShift} 到站确认`,
      } satisfies EntryRow
    })
}

function replaceRow(rows: EntryRow[], updated: EntryRow): EntryRow[] {
  return rows.map((item) => (Number(item.id) === Number(updated.id) ? updated : item))
}

// 在内存里把排班变更与由此派生的提醒组装成同一个补丁，最后由 store 原子提交。
function buildPatch(updatedDuty: EntryRow[]): Record<string, EntryRow[]> {
  return { [DUTY_KEY]: updatedDuty, [REMINDER_KEY]: deriveReminders(updatedDuty) }
}

export function runDutyAction(
  action: '确认排班' | '开始值勤' | '记录交接' | '申请调班',
  id: number,
  input: DutyActionInput = {},
): DutyActionResult {
  const rows = listRows(DUTY_KEY)
  const row = rows.find((item) => Number(item.id) === id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的值勤排班表` }
  }

  const current = String(row.status)
  const rank = statusRank(current)
  const at = (input.at ?? new Date().toISOString()).slice(0, 16).replace('T', ' ')
  const note = input.note?.trim() ?? ''
  const successor = input.successor?.trim() ?? ''

  // 交接幂等：已交接班次重复确认，直接返回成功且不改动任何数据。
  if (action === '记录交接' && current === HANDED_OVER) {
    return { ok: true, message: '该班次已交接，无需重复交接', idempotent: true }
  }

  // 已交接是终态，生命周期不能回退（含退回已调班）。
  if (isTerminal(rank)) {
    return { ok: false, message: `班次已交接，终态不允许再「${action}」` }
  }

  if (action === '确认排班') {
    if (rank !== 0) {
      return { ok: false, message: `班次当前是「${current}」，不能再确认排班` }
    }
    return commit(buildPatch(replaceRow(rows, { ...row, status: '已确认', pending: true, abnormal: false })), '排班已确认')
  }

  if (action === '开始值勤') {
    if (rank !== 1) {
      return { ok: false, message: `班次当前是「${current}」，尚未确认，不能开始值勤` }
    }
    return commit(buildPatch(replaceRow(rows, { ...row, status: '值勤中', pending: true, abnormal: false })), '班次已进入值勤中')
  }

  if (action === '申请调班') {
    // 待确认的班次还没排班落定，不能调班；调班必须给出接班（调班）人员。
    if (rank === 0) {
      return { ok: false, message: '班次尚未确认，请先确认排班再申请调班' }
    }
    if (rank >= 3) {
      return { ok: false, message: `班次当前是「${current}」，不能申请调班` }
    }
    if (!successor) {
      return { ok: false, message: '调班必须登记接班人员' }
    }
    const swapNote = `调班：${successor} 接班（${at}）${note ? `｜${note}` : ''}`
    const updated: EntryRow = {
      ...row,
      status: '已调班',
      pending: true,
      abnormal: false,
      接班人员: successor,
      交接记录: appendNote(row['交接记录'], swapNote),
    }
    return commit(buildPatch(replaceRow(rows, updated)), `调班已登记，接班人员：${successor}`)
  }

  // 记录交接：进入终态。缺接班人员的历史/未指派班次必须先补登记，原值勤日期保持不变。
  if (!canHandover(rank)) {
    return { ok: false, message: `班次当前是「${current}」，还不能交接` }
  }
  const finalSuccessor = isMissingSuccessor(row['接班人员']) ? successor : String(row['接班人员']).trim()
  if (isMissingSuccessor(finalSuccessor)) {
    return { ok: false, message: '请先登记接班人员再完成交接' }
  }
  const handoverNote = note || `交接完成：接班人 ${finalSuccessor} 已到站确认（${at}）`
  const updated: EntryRow = {
    ...row,
    status: HANDED_OVER,
    pending: false,
    abnormal: false,
    接班人员: finalSuccessor,
    交接记录: appendNote(row['交接记录'], handoverNote),
  }
  return commit(buildPatch(replaceRow(rows, updated)), `交接完成，接班人员：${finalSuccessor}`)
}

// 排班与提醒同次落库：写盘抛错时 store 缓存保持旧快照，两边一起回退。
function commit(patch: Record<string, EntryRow[]>, message: string): DutyActionResult {
  try {
    commitRows(patch)
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? `落库失败，已整体回退：${error.message}` : '落库失败，已整体回退',
    }
  }
  return { ok: true, message }
}
