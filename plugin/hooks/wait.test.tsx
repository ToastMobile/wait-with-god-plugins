import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { clockTime, hideUntil, mask, nextVerse, stageFor, verseFor, verseText, workdayStreak } from './verses'

const NOON = Date.parse('2026-10-02T12:00:00Z')
const VERSE = verseFor('2026-10-02')
const TEXT = 'And we know that God works all things together for the good of those who love Him.'
const CHAPTER = JSON.stringify({
  chapter: { content: [{ type: 'verse', number: VERSE.verse, content: [TEXT, { noteId: 1 }] }] },
})

/** Any other chapter: every verse reads as its own reference. */
const otherChapter = (url: string) =>
  JSON.stringify({
    chapter: { content: Array.from({ length: 180 }, (_, i) => ({ type: 'verse', number: i + 1, content: [`${url} ${i + 1}`] })) },
  })

function world(on: On, store: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  mock.store(on, store)
  mock.env(on, env)
  const clock = mock.clock(on, { now: NOON })
  const copied: string[] = []
  const posts: Record<string, unknown>[] = []
  on('http.fetch', (_$, e) => {
    if (e.init?.method === 'POST') {
      posts.push(JSON.parse(e.init.body ?? '{}'))
      return { value: { status: 204, ok: true, headers: {}, text: '' } }
    }
    return { value: { status: 200, ok: true, headers: {}, text: e.url === VERSE.url ? CHAPTER : otherChapter(e.url) } }
  })
  on('ui.copy', (_$, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })
  // The engine draws nothing in the band when no plugin does.
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  return { clock, copied, posts }
}

const band = (isWorking: boolean) => ({
  plugin: 'wait-with-god',
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
})

async function turns($: Engine, n: number) {
  for (let i = 0; i < n; i++) await $.turn.start({ text: 'go', turnId: `t${Math.random()}` })
}

const wait = async ($: Engine, args = '') => (await $.command.run({ command: 'wait', args } as never)).text ?? ''

const DAY = 86_400_000
const session = ($: Engine, isInteractive = true) =>
  $.session.start({ cwd: '/work', surface: 'terminal', isInteractive } as never)

/** Whole waits: the turn starts, Claude works for `ms`, the turn ends. */
async function waits($: Engine, clock: MockClock, n: number, ms = 20_000) {
  for (let i = 0; i < n; i++) {
    const turnId = `w${Math.random()}`
    await $.turn.start({ text: 'go', turnId })
    await clock.advance(ms)
    await $.turn.complete({ answer: '', durationMs: ms, isAborted: false, turnId, reason: 'answer' } as never)
  }
}

describe('verses', () => {
  test('parses helloao verse content, poetry included', () => {
    const poem = JSON.stringify({
      chapter: { content: [{ type: 'verse', number: 105, content: [{ text: 'Your word is a lamp to my feet', poem: 1 }, { text: 'and a light to my path.', poem: 2 }] }] },
    })
    expect(verseText(poem, 105)).toBe('Your word is a lamp to my feet and a light to my path.')
    expect(verseText(CHAPTER, VERSE.verse)).toBe(TEXT)
  })

  test('steps from Read to Check and hides more each step', () => {
    expect([6, 7, 16, 25].map(stageFor)).toEqual(['Read', 'Repeat', 'Recall', 'Check'])
    const hidden = (s: string) => (s.match(/_/g) ?? []).length
    expect(mask(TEXT, 6)).toBe(TEXT)
    expect(hidden(mask(TEXT, 18))).toBeGreaterThan(hidden(mask(TEXT, 15)))
    expect(mask(TEXT, 25)).toStartWith('A__ w_ k___')
    expect(mask(TEXT, 10)).toBe(mask(TEXT, 10))
  })

  test('Repeat and Recall start with a few blanks and keep them as they add more', () => {
    const blanked = (s: string) => s.split(' ').flatMap((w, i) => (w.includes('_') ? [i] : []))
    const looks = Array.from({ length: 18 }, (_, i) => blanked(mask(TEXT, 7 + i)))
    expect([looks[0]!.length, looks[8]!.length]).toEqual([2, 6])
    expect([looks[9]!.length, looks[17]!.length]).toEqual([7, 14])
    for (let i = 1; i < looks.length; i++) {
      expect(looks[i - 1]!.every(w => looks[i]!.includes(w))).toBe(true)
    }
    // Recall keeps each blanked word's first letter.
    expect(mask(TEXT, 16).split(' ').filter(w => w.includes('_')).every(w => /^\p{L}/u.test(w))).toBe(true)
  })

  test('next skips memorized verses and wraps around the plan', () => {
    const after = (ref: string, mastered: string[] = []) => nextVerse(ref, mastered).ref
    expect(after('Romans 8:28')).toBe('John 3:16')
    expect(after('Romans 8:28', ['John 3:16', 'Psalm 118:24'])).toBe('Joshua 1:9')
    expect(after('Matthew 5:16')).toBe('Romans 8:28')
  })

  test('hide runs an hour or to local midnight', () => {
    const now = new Date(2026, 9, 5, 15, 5).getTime()
    expect(clockTime(hideUntil('hour', now))).toBe('4:05 PM')
    expect(hideUntil('today', now)).toBe(new Date(2026, 9, 6).getTime())
    expect(clockTime(new Date(2026, 9, 5, 0, 30).getTime())).toBe('12:30 AM')
  })

  test('workday streak skips weekends', () => {
    // Fri 10/2, Thu 10/1, Mon 9/28 present; Tue/Wed missing.
    expect(workdayStreak(['2026-09-25', '2026-09-28', '2026-10-01', '2026-10-02'], '2026-10-02')).toBe(2)
    // Mon 10/5 with the previous Fri: the weekend does not break it.
    expect(workdayStreak(['2026-10-02', '2026-10-05'], '2026-10-05')).toBe(2)
  })
})

describe('band', () => {
  test('shows the verse only while Claude works, on every surface', async ($, on) => {
    world(on)
    await turns($, 1)
    for (const surface of ['terminal', 'desktop'] as const) {
      const busy = await $.ui.mount({ ...band(true), surface })
      expect(await busy.find({ type: 'Text', text: TEXT })).toBeDefined()
      expect(await busy.find({ type: 'Text', text: /Read/ })).toBeDefined()
      const idle = await $.ui.mount({ ...band(false), surface })
      expect(await idle.find({ type: 'Text', text: /Wait with God/ })).toBeUndefined()
    }
  })

  test('obscures, reveals, and masters', async ($, on) => {
    world(on)
    await turns($, 7)
    const repeat = await $.ui.mount({ ...band(true), surface: 'terminal' })
    expect(await repeat.find({ type: 'Text', text: /Fill in the blanks/ })).toBeDefined()
    expect(await repeat.find({ type: 'Text', text: TEXT })).toBeUndefined()
    await repeat.press({ key: 'reveal' })
    expect(await repeat.find({ type: 'Text', text: TEXT })).toBeDefined()

    await turns($, 18)
    const check = await $.ui.mount({ ...band(true), surface: 'terminal' })
    expect(await check.find({ type: 'Text', text: /Say it from memory/ })).toBeDefined()
    await check.press({ key: 'got' })
    expect(await check.find({ type: 'Text', text: /mastered/ })).toBeDefined()

    expect(await wait($)).toContain('1 verse memorized')
  })

  test('credits Versle', async ($, on) => {
    world(on)
    await turns($, 1)
    const busy = await $.ui.mount({ ...band(true), surface: 'terminal' })
    expect(await busy.find({ type: 'Text', text: /^From$/ })).toBeDefined()
    expect(await busy.find({ type: 'Link' })).toBeDefined()
  })

  test('names no step, and shares the whole verse with the website', async ($, on) => {
    const { copied } = world(on)
    await turns($, 18)
    for (const surface of ['terminal', 'desktop'] as const) {
      const busy = await $.ui.mount({ ...band(true), surface })
      expect(await busy.find({ type: 'Text', text: /Recall it from the first letters/ })).toBeDefined()
      expect(await busy.find({ type: 'Text', text: /· Recall ·/ })).toBeUndefined()
      await busy.press({ key: 'share' })
    }
    expect(copied).toEqual([1, 2].map(() => `“${TEXT}” — ${VERSE.ref} (BSB)\n\nhttps://waitwithgod.com`))
  })
})

describe('/wait', () => {
  test('copy puts the whole verse on the clipboard, even mid-Recall', async ($, on) => {
    const { copied } = world(on)
    await turns($, 18)
    expect(await wait($, 'copy')).toContain('Copied')
    expect(copied).toEqual([`“${TEXT}” — ${VERSE.ref} (BSB)`])
  })

  test('hide stops the band and the counting until show', async ($, on) => {
    world(on)
    await turns($, 3)
    expect(await wait($, 'hide')).toContain('Hidden until')
    await turns($, 5)
    expect(await (await $.ui.mount({ ...band(true), surface: 'terminal' })).find({ type: 'Text', text: /Wait with God/ })).toBeUndefined()
    expect(await wait($)).toContain('3 looks today')

    await wait($, 'show')
    await turns($, 1)
    expect(await (await $.ui.mount({ ...band(true), surface: 'terminal' })).find({ type: 'Text', text: /Wait with God/ })).toBeDefined()
    expect(await wait($)).toContain('4 looks today')
  })

  test('an hour\'s hide runs out on its own', async ($, on) => {
    const { clock } = world(on)
    await turns($, 1)
    await wait($, 'hide')
    await clock.advance(61 * 60_000)
    expect(await (await $.ui.mount({ ...band(true), surface: 'terminal' })).find({ type: 'Text', text: /Wait with God/ })).toBeDefined()
  })

  test('next swaps in the next verse from Read', async ($, on) => {
    world(on)
    await turns($, 10)
    const swapped = nextVerse(VERSE.ref, [])
    expect(await wait($, 'next')).toContain(swapped.ref)
    await turns($, 1)
    const busy = await $.ui.mount({ ...band(true), surface: 'terminal' })
    expect(await busy.find({ type: 'Text', text: new RegExp(`${swapped.ref}.*Read`) })).toBeDefined()
  })

  test('anything else shows the usage', async ($, on) => {
    world(on)
    expect(await wait($, 'nope')).toContain('/wait hide [today]')
  })
})

describe('usage count', () => {
  test('an install, then one active day at a time with the day before', async ($, on) => {
    const { clock, posts } = world(on)
    await session($)
    await clock.advance(5_000)
    expect(posts).toEqual([
      { e: 'install', client: 'plugin', v: '0.3.2', platform: 'terminal', app: 'claude-code', installed: '2026-10-02', day: '2026-10-02' },
    ])

    await waits($, clock, 3)
    await clock.advance(60_000)
    const first = posts.filter(p => p.e === 'active')
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ day: '2026-10-02', installed: '2026-10-02', mastered: 0 })
    expect(first[0]!.prev_day).toBeUndefined()

    await clock.set(NOON + DAY)
    await waits($, clock, 2)
    await clock.advance(60_000)
    const active = posts.filter(p => p.e === 'active')
    expect(active).toHaveLength(2)
    expect(active[1]).toMatchObject({ day: '2026-10-03', prev_day: '2026-10-02', prev_looks: 3, prev_waited_s: 60 })
    expect(posts.filter(p => p.e === 'install')).toHaveLength(1)
  })

  test('someone who used it before counting began is not a new install', async ($, on) => {
    const stats = { waitedMs: 0, waitedByDay: {}, reviews: {}, looksByDay: {}, mastered: [], activeDays: ['2026-09-30'] }
    const { clock, posts } = world(on, { stats })
    await session($)
    await waits($, clock, 1)
    await clock.advance(60_000)
    expect(posts.map(p => p.e)).toEqual(['active'])
    expect(posts[0]).toMatchObject({ installed: '2026-09-30', prev_day: '2026-09-30' })
  })

  test('an active day a short session missed goes out at the next start', async ($, on) => {
    const stats = { waitedMs: 3000, waitedByDay: { '2026-10-01': 3000 }, reviews: {}, looksByDay: { '2026-10-01': 1 }, mastered: [], activeDays: ['2026-10-01'] }
    const { clock, posts } = world(on, { stats, installedOn: '2026-10-01', installReported: true })
    await session($)
    await clock.advance(5_000)
    expect(posts).toHaveLength(1)
    expect(posts[0]).toMatchObject({ e: 'active', day: '2026-10-01', installed: '2026-10-01' })
  })

  test('the first reply of the day is reported within seconds', async ($, on) => {
    const { clock, posts } = world(on)
    await session($)
    await waits($, clock, 1, 3_000)
    await clock.advance(1_000)
    expect(posts.map(p => p.e)).toEqual(['install', 'active'])
  })

  test('nothing is sent under DO_NOT_TRACK', async ($, on) => {
    const { clock, posts } = world(on, {}, { DO_NOT_TRACK: '1' })
    await session($)
    await waits($, clock, 2)
    await clock.advance(120_000)
    expect(posts).toEqual([])
  })

  test('a -p run sends nothing', async ($, on) => {
    const { clock, posts } = world(on)
    await session($, false)
    await waits($, clock, 2)
    await clock.advance(120_000)
    expect(posts).toEqual([])
  })
})
