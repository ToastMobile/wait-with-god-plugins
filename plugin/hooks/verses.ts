import type { WaitStage, WaitStats } from '../types'

/** One verse a day, cycling. Short, well-known memory verses. */
export const PLAN: ReadonlyArray<readonly [book: string, name: string, chapter: number, verse: number]> = [
  ['ROM', 'Romans', 8, 28],
  ['JHN', 'John', 3, 16],
  ['PSA', 'Psalm', 118, 24],
  ['JOS', 'Joshua', 1, 9],
  ['PHP', 'Philippians', 4, 6],
  ['ISA', 'Isaiah', 40, 31],
  ['PSA', 'Psalm', 119, 105],
  ['MAT', 'Matthew', 11, 28],
  ['ROM', 'Romans', 12, 2],
  ['2TI', '2 Timothy', 1, 7],
  ['PSA', 'Psalm', 46, 10],
  ['GAL', 'Galatians', 2, 20],
  ['PSA', 'Psalm', 37, 4],
  ['HEB', 'Hebrews', 11, 1],
  ['1PE', '1 Peter', 5, 7],
  ['JAS', 'James', 1, 5],
  ['MAT', 'Matthew', 6, 33],
  ['ROM', 'Romans', 5, 8],
  ['2CO', '2 Corinthians', 5, 17],
  ['ISA', 'Isaiah', 26, 3],
  ['HEB', 'Hebrews', 13, 8],
  ['1JN', '1 John', 1, 9],
  ['MIC', 'Micah', 6, 8],
  ['LAM', 'Lamentations', 3, 22],
  ['JHN', 'John', 14, 6],
  ['PRO', 'Proverbs', 18, 10],
  ['ISA', 'Isaiah', 41, 10],
  ['PHP', 'Philippians', 4, 13],
  ['PSA', 'Psalm', 23, 1],
  ['JER', 'Jeremiah', 29, 11],
  ['MAT', 'Matthew', 5, 16],
]

export const API = 'https://bible.helloao.org/api/BSB'

const DAY_MS = 86_400_000

/** Local calendar day for a timestamp, YYYY-MM-DD. */
export function dayKey(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export type PlanVerse = { book: string; chapter: number; verse: number; ref: string; url: string }

/** The plan entry at an index, wrapping around the plan. */
function planVerse(index: number): PlanVerse {
  const [book, name, chapter, verse] = PLAN[((index % PLAN.length) + PLAN.length) % PLAN.length]!
  return { book, chapter, verse, ref: `${name} ${chapter}:${verse}`, url: `${API}/${book}/${chapter}.json` }
}

/** The plan entry for a day: everyone on the same day sees the same verse. */
export function verseFor(day: string): PlanVerse {
  return planVerse(Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS))
}

/** The verse after `ref` in the plan that isn't memorized yet, or simply the next one once all are. */
export function nextVerse(ref: string, mastered: readonly string[]): PlanVerse {
  const start = Math.max(PLAN.findIndex((_, i) => planVerse(i).ref === ref), 0)
  const upcoming = Array.from({ length: PLAN.length - 1 }, (_, i) => planVerse(start + 1 + i))
  return upcoming.find(v => !mastered.includes(v.ref)) ?? upcoming[0]!
}

export const SITE = 'https://waitwithgod.com'

/** The verse as it is copied: whole, never blanked. */
export function quoted(ref: string, text: string): string {
  return `“${text}” — ${ref} (BSB)`
}

/** The verse as it is shared: whole, with the website, as one message. */
export function shared(ref: string, text: string): string {
  return `${quoted(ref, text)}\n\n${SITE}`
}

/** When a hide runs out: an hour from now, or the start of tomorrow (local time). */
export function hideUntil(span: 'hour' | 'today', now: number): number {
  if (span === 'hour') return now + 3_600_000
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
}

/** Local clock time, e.g. "3:05 PM". */
export function clockTime(ms: number): string {
  const d = new Date(ms)
  const h = d.getHours() % 12 || 12
  return `${h}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`
}

type Piece = string | { text?: string; lineBreak?: boolean; noteId?: number }

/** Pulls one verse's plain text out of a helloao chapter JSON body. */
export function verseText(body: string, verse: number): string | null {
  const json = JSON.parse(body) as { chapter?: { content?: Array<{ type: string; number?: number; content?: Piece[] }> } }
  const found = json.chapter?.content?.find(c => c.type === 'verse' && c.number === verse)
  if (!found?.content) return null
  const text = found.content
    .map(p => (typeof p === 'string' ? p : p.text ?? (p.lineBreak ? ' ' : '')))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text || null
}

/** The looks that show Repeat and Recall, and the share of words each blanks from its first look to its last. */
const REPEAT = { first: 7, last: 15, start: 0.1, rise: 0.25 }
const RECALL = { first: 16, last: 24, start: 0.4, rise: 0.4 }

/** Which memorization step a number of views lands on. */
export function stageFor(views: number): WaitStage {
  if (views < REPEAT.first) return 'Read'
  if (views <= REPEAT.last) return 'Repeat'
  if (views <= RECALL.last) return 'Recall'
  return 'Check'
}

/** Small deterministic PRNG so the same view hides the same words on every redraw. */
function rng(seed: number) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return ((s >>> 0) % 10_000) / 10_000
  }
}

function hash(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return h >>> 0
}

const WORD = /^([^\p{L}\p{N}]*)([\p{L}\p{N}'’-]+)([^\p{L}\p{N}]*)$/u

function blank(word: string, keepFirst: boolean): string {
  const m = WORD.exec(word)
  if (!m) return word
  const [, lead, core, tail] = m as unknown as [string, string, string, string]
  const letters = [...core]
  const shown = keepFirst ? letters[0]! + '_'.repeat(letters.length - 1) : '_'.repeat(letters.length)
  return lead + shown + tail
}

/** How many words to blank, at least one: Repeat goes from 10% to 35% of them, Recall from 40% to 80%. */
function blankCount(views: number, total: number): number {
  const { first, last, start, rise } = stageFor(views) === 'Repeat' ? REPEAT : RECALL
  const progress = Math.min(Math.max((views - first) / (last - first), 0), 1)
  return Math.max(1, Math.round((start + rise * progress) * total))
}

/**
 * The verse after so many views today:
 * Read shows it whole. Repeat blanks a few words at first and works up to about a third. Recall cuts
 * those and more to their first letters, working up to most of them. Check cuts them all. The words go
 * in a fixed order per verse, so each look keeps the earlier blanks.
 */
export function mask(text: string, views: number): string {
  const stage = stageFor(views)
  if (stage === 'Read') return text
  const words = text.split(' ')
  if (stage === 'Check') return words.map(w => blank(w, true)).join(' ')
  const order = words.flatMap((w, i) => (WORD.test(w) ? [i] : []))
  const next = rng(hash(text))
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    ;[order[i], order[j]] = [order[j]!, order[i]!]
  }
  const hidden = new Set(order.slice(0, blankCount(views, order.length)))
  return words.map((w, i) => (hidden.has(i) ? blank(w, stage === 'Recall') : w)).join(' ')
}

export function emptyStats(): WaitStats {
  return { waitedMs: 0, waitedByDay: {}, reviews: {}, looksByDay: {}, mastered: [], activeDays: [] }
}

function isWeekday(day: string): boolean {
  const dow = new Date(`${day}T12:00:00Z`).getUTCDay()
  return dow !== 0 && dow !== 6
}

/** Consecutive workdays (Mon–Fri) with a wait, ending today; weekends neither count nor break it. */
export function workdayStreak(activeDays: readonly string[], today: string): number {
  const active = new Set(activeDays)
  let streak = 0
  let cursor = Date.parse(`${today}T12:00:00Z`)
  for (let i = 0; i < 400; i++) {
    const day = new Date(cursor).toISOString().slice(0, 10)
    if (isWeekday(day)) {
      if (active.has(day)) streak += 1
      else if (day !== today) break
    }
    cursor -= DAY_MS
  }
  return streak
}

export function minutes(ms: number): string {
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total}s`
  const m = Math.floor(total / 60)
  if (m < 60) return `${m}m ${total % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}
