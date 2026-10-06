/** Today's verse and how many times it has been seen while Claude worked. */
export type WaitToday = {
  /** Local date, YYYY-MM-DD. */
  day: string
  /** Human reference, e.g. "Romans 8:28". */
  ref: string
  /** Text of the verse, in `bible`. */
  text: string
  /** YouVersion id of the version `text` is in; older saved verses lack it and are the BSB. */
  bible?: number
  /** Waits today that showed this verse (drives Read → Repeat → Recall → Check). */
  views: number
  /** Marked "Got it" in the Check stage. */
  isMastered: boolean
}

/** Running totals kept across sessions in $.store. */
export type WaitStats = {
  /** Milliseconds spent waiting on Claude, all time. */
  waitedMs: number
  /** Milliseconds spent waiting on Claude, keyed by day. */
  waitedByDay: Record<string, number>
  /** Times each reference has been shown. */
  reviews: Record<string, number>
  /** Looks (waits that showed the verse), keyed by day. */
  looksByDay: Record<string, number>
  /** References marked mastered. */
  mastered: string[]
  /** Days (YYYY-MM-DD) with at least one wait, most recent last. */
  activeDays: string[]
}

export type WaitStage = 'Read' | 'Repeat' | 'Recall' | 'Check'

declare module 'claude-code' {
  interface PluginState {
    'wait-with-god': {
      today: WaitToday | null
      isRevealed: boolean
      /** When `/wait hide` runs out (ms since epoch), or null when shown. */
      hiddenUntil: number | null
      /** What the last press of Share did, shown on the button for a moment; null at rest. */
      shareResult: 'copied' | 'failed' | null
    }
  }
}
