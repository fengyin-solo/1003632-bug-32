/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

// 值勤交接记录：与排班表分开落库，但由排班状态在同一事务内派生。
export type HandoverRecord = {
  id: number
  dutyId: number
  排班编号: string
  值勤日期: string
  交班人: string
  接班人: string
  交接时间: string
  交接说明: string
}

// 检查站提醒：只从排班表待交接（pending=true）的班次派生，与排班同次落库，不单独编辑。
export type DutyReminder = {
  id: number
  dutyId: number
  排班编号: string
  值勤日期: string
  值勤时段: string
  值勤岗位: string
  当前值勤人: string
  提醒类型: string
  更新时间: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
