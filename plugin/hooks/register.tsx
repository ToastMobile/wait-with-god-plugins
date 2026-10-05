import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { WaitStats, WaitToday } from '../types'
import type { PlanVerse } from './verses'
import {
  clockTime,
  dayKey,
  emptyStats,
  hideUntil,
  mask,
  minutes,
  nextVerse,
  quoted,
  shared,
  SITE,
  stageFor,
  verseFor,
  verseText,
  workdayStreak,
} from './verses'

const today = atom({ plugin: 'wait-with-god', key: 'today' } as const, null)
const isRevealed = atom({ plugin: 'wait-with-god', key: 'isRevealed' } as const, false)
const hiddenUntil = atom({ plugin: 'wait-with-god', key: 'hiddenUntil' } as const, null)

const VERSLE = 'https://get.versle.app/p/waitwithgod'

/** Must match .claude-plugin/plugin.json (release.sh checks). */
const VERSION = '0.3.2'
const EVENTS = 'https://waitwithgod.com/a'

const HINT = {
  Read: 'Read it slowly.',
  Repeat: 'Fill in the blanks.',
  Recall: 'Recall it from the first letters.',
  Check: 'Say it from memory, then reveal.',
} as const

const USAGE = [
  '/wait              today\'s verse and your totals',
  '/wait copy         copy the whole verse',
  '/wait next         switch to the next verse you haven\'t memorized',
  '/wait hide [today] hide the band for an hour, or for the rest of today',
  '/wait show         show it again',
  '/wait reset        restart today\'s verse at Read',
].join('\n')

async function loadStats($: EngineInterface): Promise<WaitStats> {
  const saved = (await $.store.get('stats')) as Partial<WaitStats> | undefined
  return { ...emptyStats(), ...(saved ?? {}) }
}

async function saveToday($: EngineInterface, verse: WaitToday) {
  await $.store.set('today', verse)
  await update($, today, () => verse)
}

/** A plan verse's BSB text, fetched once and cached. */
async function textFor($: EngineInterface, plan: PlanVerse): Promise<string | null> {
  const cached = (await $.store.get(`text:${plan.ref}`)) as string | undefined
  if (cached) return cached
  const res = await $.http.fetch(plan.url)
  if (!res.ok) return null
  const text = verseText(res.text, plan.verse)
  if (text) await $.store.set(`text:${plan.ref}`, text)
  return text
}

/** Makes `plan` today's verse, starting from Read. */
async function startVerse($: EngineInterface, day: string, plan: PlanVerse): Promise<WaitToday | null> {
  const text = await textFor($, plan)
  if (!text) return null
  const stats = await loadStats($)
  const fresh: WaitToday = { day, ref: plan.ref, text, views: 0, isMastered: stats.mastered.includes(plan.ref) }
  await saveToday($, fresh)
  await update($, isRevealed, () => false)
  return fresh
}

/** Makes sure `today` holds today's verse, fetching the BSB text once per verse. */
async function ensureToday($: EngineInterface): Promise<WaitToday | null> {
  const day = dayKey(await $.clock.now())
  const held = await read($, today)
  if (held?.day === day) return held

  const saved = (await $.store.get('today')) as WaitToday | undefined
  if (saved?.day === day) {
    await update($, today, () => saved)
    return saved
  }
  return startVerse($, day, verseFor(day))
}

/** Hidden by `/wait hide`, until it runs out. */
async function isHidden($: EngineInterface): Promise<boolean> {
  const until = await read($, hiddenUntil)
  return until !== null && (await $.clock.now()) < until
}

async function setHidden($: EngineInterface, until: number | null) {
  await $.store.set('hiddenUntil', until)
  await update($, hiddenUntil, () => until)
}

/**
 * The anonymous usage count the README describes: "install" once, then "active" for each day with a wait,
 * carrying the previous active day's totals. Nothing identifies the person; the install date is what retention
 * is counted by.
 */
type Usage = { surface: string; isSending: boolean }

/** How far back an active day an earlier session didn't get to send is still sent. */
const CATCH_UP_MS = 7 * 86_400_000

async function post($: EngineInterface, event: Record<string, unknown>): Promise<boolean> {
  const res = await $.http.fetch(EVENTS, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': `wait-with-god-plugin/${VERSION}` },
    body: JSON.stringify(event),
  })
  return res.ok
}

async function sendUsage($: EngineInterface, usage: Usage) {
  if (usage.isSending) return
  usage.isSending = true
  try {
    const dnt = (await $.env.get('DO_NOT_TRACK'))?.toLowerCase()
    if (dnt === '1' || dnt === 'true') return
    const installed = (await $.store.get('installedOn')) as string | undefined
    if (!installed) return
    const base = { client: 'plugin', v: VERSION, platform: usage.surface, app: 'claude-code', installed }

    if ((await $.store.get('installReported')) !== true && (await post($, { e: 'install', ...base, day: installed }))) {
      await $.store.set('installReported', true)
    }

    // Every active day not yet sent, oldest first, so a session that ended quickly is caught up by the next.
    const stats = await loadStats($)
    const reported = ((await $.store.get('reportedDay')) as string | undefined) ?? ''
    const oldest = dayKey((await $.clock.now()) - CATCH_UP_MS)
    for (const day of stats.activeDays) {
      if (day <= reported || day < oldest || day < installed) continue
      const prev = stats.activeDays.filter(d => d < day).at(-1)
      const event = {
        e: 'active',
        ...base,
        day,
        streak: workdayStreak(stats.activeDays, day),
        mastered: stats.mastered.length,
        ...(prev && {
          prev_day: prev,
          prev_looks: stats.looksByDay[prev] ?? 0,
          prev_waited_s: Math.round((stats.waitedByDay[prev] ?? 0) / 1000),
        }),
      }
      if (!(await post($, event))) return
      await $.store.set('reportedDay', day)
    }
  } catch {
    // Offline: the next check tries again.
  } finally {
    usage.isSending = false
  }
}

export const register: Register = on => {
  const startedAt = new Map<string, number>()
  const usage: Usage = { surface: 'none', isSending: false }
  // Usage is only sent from a session a person is at, not a -p run.
  let isInteractive = false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'wait',
      description: "Today's verse and how much waiting you've redeemed",
      argumentHint: '[copy | next | hide [today] | show | reset]',
      immediate: true,
    })
    const until = (await $.store.get('hiddenUntil')) as number | null | undefined
    await update($, hiddenUntil, () => until ?? null)
    try {
      await ensureToday($)
    } catch {
      // Offline: try again on the next turn.
    }
    // Usage goes out on timers, never in a turn's way, and only from a session a person is at.
    usage.surface = e.surface ?? 'none'
    if (e.isInteractive) {
      if (!(await $.store.get('installedOn'))) {
        const stats = await loadStats($)
        await $.store.set('installedOn', stats.activeDays[0] ?? dayKey(await $.clock.now()))
        // Someone who used the plugin before usage counting is not a new install, and their past days aren't sent.
        if (stats.activeDays.length > 0) {
          await $.store.set('installReported', true)
          await $.store.set('reportedDay', stats.activeDays.at(-1))
        }
      }
      isInteractive = true
      $.clock.after(5_000, () => void sendUsage($, usage))
      $.clock.every(60_000, () => void sendUsage($, usage))
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    // Hidden: no look, no time counted, as if the band weren't installed.
    if (await isHidden($)) return next(e)
    startedAt.set(e.turnId, await $.clock.now())
    try {
      const verse = await ensureToday($)
      if (verse) {
        await saveToday($, { ...verse, views: verse.views + 1 })
        await update($, isRevealed, () => false)
      }
    } catch {
      // Never hold up a turn over Scripture loading.
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const began = startedAt.get(e.turnId)
    startedAt.delete(e.turnId)
    const verse = await read($, today)
    if (began !== undefined && verse) {
      const waited = (await $.clock.now()) - began
      const stats = await loadStats($)
      stats.waitedMs += waited
      stats.waitedByDay[verse.day] = (stats.waitedByDay[verse.day] ?? 0) + waited
      stats.reviews[verse.ref] = (stats.reviews[verse.ref] ?? 0) + 1
      stats.looksByDay[verse.day] = (stats.looksByDay[verse.day] ?? 0) + 1
      if (!stats.activeDays.includes(verse.day)) stats.activeDays = [...stats.activeDays, verse.day].slice(-400)
      await $.store.set('stats', stats)
      // A new active day goes out a moment later, even if the session ends soon after.
      if (isInteractive) $.clock.after(1_000, () => void sendUsage($, usage))
    }
    return next(e)
  })

  on('command.run', { command: 'wait' }, async ($, e) => {
    const [sub = '', arg = ''] = e.args.trim().toLowerCase().split(/\s+/)
    const offline = { text: "Couldn't reach the Bible API. Wait with God will try again on your next prompt." }

    switch (sub) {
      case '':
        break
      case 'reset': {
        const verse = await ensureToday($)
        if (verse) await saveToday($, { ...verse, views: 0 })
        return { text: "Today's verse is back to the Read step." }
      }
      case 'copy': {
        const verse = await ensureToday($)
        if (!verse) return offline
        const text = quoted(verse.ref, verse.text)
        const copied = await $.ui.copy({ text })
        return { text: copied.isCopied ? `Copied ${verse.ref}.` : `Couldn't reach the clipboard. Here it is to copy:\n\n${text}` }
      }
      case 'next': {
        const verse = await ensureToday($)
        if (!verse) return offline
        const stats = await loadStats($)
        const swapped = await startVerse($, verse.day, nextVerse(verse.ref, stats.mastered))
        if (!swapped) return offline
        return { text: `Today's verse is now ${swapped.ref}, starting from Read. Tomorrow goes back to the plan.` }
      }
      case 'hide': {
        if (arg !== '' && arg !== 'today' && arg !== 'hour' && arg !== '1h') return { text: USAGE }
        const span = arg === 'today' ? 'today' : 'hour'
        const until = hideUntil(span, await $.clock.now())
        await setHidden($, until)
        return {
          text: `${span === 'today' ? 'Hidden for the rest of today' : `Hidden until ${clockTime(until)}`}. /wait show brings it back.`,
        }
      }
      case 'show':
        await setHidden($, null)
        return { text: 'Wait with God will show on your next prompt.' }
      default:
        return { text: USAGE }
    }

    const verse = await ensureToday($)
    const stats = await loadStats($)
    if (!verse) return offline

    const todayMs = stats.waitedByDay[verse.day] ?? 0
    const reviews = stats.reviews[verse.ref] ?? 0
    const streak = workdayStreak(stats.activeDays, verse.day)
    const until = await read($, hiddenUntil)
    const lines = [
      `${verse.ref} (BSB)`,
      `"${verse.text}"`,
      '',
      `Step: ${stageFor(verse.views)} · ${verse.views} look${verse.views === 1 ? '' : 's'} today${verse.isMastered ? ' · mastered' : ''}`,
      `Today you redeemed ${minutes(todayMs)} of waiting and reviewed ${verse.ref} ${reviews} time${reviews === 1 ? '' : 's'}.`,
      `All time: ${minutes(stats.waitedMs)} redeemed · ${stats.mastered.length} verse${stats.mastered.length === 1 ? '' : 's'} memorized · ${streak}-workday streak.`,
      ...((await isHidden($)) && until !== null ? [`Hidden until ${clockTime(until)} · /wait show`] : []),
    ]
    return { text: lines.join('\n') }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Only while Claude is busy: the instant it needs you, the band is gone.
    if (!e.props.isWorking || e.props.hasSurvey) return next(e)
    if (await isHidden($)) return next(e)
    const verse = await read($, today)
    if (!verse || verse.views === 0) return next(e)

    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const stage = stageFor(verse.views)
    const revealed = stage === 'Read' || (await read($, isRevealed))
    const shown = revealed ? verse.text : mask(verse.text, verse.views)

    return (
      <Box flexDirection="column" width={e.props.bodyColumns}>
        <Text dimColor>
          ✦ <Link href={SITE}>Wait with God</Link> · {verse.ref} (BSB) ·{' '}
          {revealed && stage !== 'Read' ? 'Revealed.' : HINT[stage]}
        </Text>
        <Text wrap="wrap" italic={!revealed}>
          {shown}
        </Text>
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row" gap={1}>
            {stage !== 'Read' && !revealed && (
              <Button key="reveal" label="Reveal" hotkey="r" onPress={() => update($, isRevealed, () => true)} />
            )}
            {stage === 'Check' && !verse.isMastered && (
              <Button
                key="got"
                label="Got it"
                hotkey="g"
                variant="primary"
                onPress={async () => {
                  const stats = await loadStats($)
                  if (!stats.mastered.includes(verse.ref)) stats.mastered = [...stats.mastered, verse.ref]
                  await $.store.set('stats', stats)
                  await saveToday($, { ...verse, isMastered: true })
                  await update($, isRevealed, () => true)
                  $.ui.toast(
                    `${verse.ref} memorized. ${stats.mastered.length} verse${stats.mastered.length === 1 ? '' : 's'} learned while waiting.`,
                  )
                }}
              />
            )}
            {stage === 'Check' && verse.isMastered && <Text dimColor>✓ mastered</Text>}
            <Button
              key="share"
              label="Share"
              hotkey="s"
              dimColor
              onPress={async press => {
                const copied = await $.ui.copy({ text: shared(verse.ref, verse.text), surface: press.surface })
                $.ui.toast(copied.isCopied ? `Copied ${verse.ref} and a link to share.` : "Couldn't reach the clipboard.")
              }}
            />
          </Box>
          <Box flexDirection="row" gap={1}>
            <Text dimColor>From</Text>
            <Link href={VERSLE} label="Versle" />
          </Box>
        </Box>
      </Box>
    )
  })
}
