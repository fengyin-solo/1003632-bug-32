import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'forest-fire-patrol:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 数据块：业务模块是 EntryRow[]；值勤派生块（交接记录、检查站提醒）结构不同，用 unknown 承接。
export type DataBlock = EntryRow[] | unknown

function seedFallback(): Record<string, DataBlock> {
  return clone(SEED_ROWS) as Record<string, DataBlock>
}

function readStorage(): Record<string, DataBlock> {
  const fallback = seedFallback()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, DataBlock>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, DataBlock> | null = null

export function allRows(): Record<string, DataBlock> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  const block = allRows()[key]
  return Array.isArray(block) ? (block as EntryRow[]) : []
}

// 直接读取任意数据块（交接记录、提醒等派生块）；未播种时返回 undefined，由调用方负责补建。
export function getBlock<T>(key: string): T | undefined {
  const block = allRows()[key]
  return block === undefined ? undefined : (block as T)
}

export function saveRows(key: string, rows: EntryRow[]): void {
  commit({ [key]: rows })
}

// 一次业务动作涉及的所有数据块一次性写进 localStorage：任一序列化/写入失败，缓存整体回退。
// 这保证「排班状态 + 交接记录 + 检查站提醒」要么同次落库，要么一起不动。
export function commit(updates: Record<string, DataBlock>): void {
  const previous = cache
  try {
    const next = { ...allRows(), ...updates }
    cache = next
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    }
  } catch (error) {
    // setItem 失败时浏览器不会留下半截写入（单次 key 赋值是原子的），存储仍是旧内容；
    // 这里只需把内存缓存回退到写前快照，不能再次 setItem——那可能再次抛错并穿透给调用方。
    cache = previous
    throw error instanceof Error ? error : new Error('数据写入失败，已回退本次操作')
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

// 重置某模块时把它的派生块一起清掉/重播种，避免刷新后旧派生标记又回来。
export function resetBlocks(updates: Record<string, DataBlock>): void {
  commit(updates)
}

export function storageKey(): string {
  return STORAGE_KEY
}
