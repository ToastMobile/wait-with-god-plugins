import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  APP_KEY,
  BSB,
  clockTime,
  hideUntil,
  mask,
  nextVerse,
  passageUrl,
  stageFor,
  verseFor,
  verseText,
  workdayStreak,
} from './verses'

const NOON = Date.parse('2026-10-02T12:00:00Z')
const VERSE = verseFor('2026-10-02')
const TEXT = 'And we know that God works all things together for the good of those who love Him.'
/** A YouVersion passage body (format=html) holding `html`. */
const passage = (html: string) => JSON.stringify({ id: 'X', content: `<div>${html}</div>`, reference: 'X' })
const PASSAGE = passage(`<div class="p"><span class="yv-v" v="28"></span><span class="yv-vlbl">28</span>${TEXT} </div>`)

/** Any other passage reads as its own URL. */
const otherPassage = (url: string) => passage(`<div class="p">${url}</div>`)

/** Versions whose passages the API fails to serve, for a test to set. */
type Outage = { down: number[] }

function world(on: On, store: Record<string, unknown> = {}, env: Record<string, string> = {}, outage: Outage = { down: [] }) {
  mock.store(on, store)
  mock.env(on, env)
  const clock = mock.clock(on, { now: NOON })
  const copied: string[] = []
  const posts: Record<string, unknown>[] = []
  const fetched: string[] = []
  const panes: string[] = []
  on('http.fetch', (_$, e) => {
    if (e.init?.method === 'POST') {
      posts.push(JSON.parse(e.init.body ?? '{}'))
      return { value: { status: 204, ok: true, headers: {}, text: '' } }
    }
    fetched.push(e.url)
    if (e.init?.headers?.['x-yvp-app-key'] !== APP_KEY) return { value: { status: 401, ok: false, headers: {}, text: '' } }
    if (outage.down.some(id => e.url.includes(`/bibles/${id}/`))) return { value: { status: 503, ok: false, headers: {}, text: '' } }
    return { value: { status: 200, ok: true, headers: {}, text: e.url === passageUrl(VERSE, BSB) ? PASSAGE : otherPassage(e.url) } }
  })
  on('ui.open', (_$, e) => {
    panes.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_$, e) => {
    panes.splice(panes.indexOf(e.id), 1)
    return { value: undefined }
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
  return { clock, copied, posts, fetched, panes }
}

/** The version picker, as the engine asks for it once it is open. */
const picker = {
  plugin: 'wait-with-god',
  component: 'Pane' as const,
  requestId: 'version',
  props: {
    title: 'Bible version',
    isFocused: true,
    bodyColumns: 80,
    placement: 'inline' as const,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
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
  test('parses YouVersion passages: poetry, the divine name in capitals, no psalm title', () => {
    const psalm = passage(
      '<div class="d"><span class="yv-v" v="1"></span><span class="yv-vlbl">1</span>A Psalm of David.</div>' +
        '<div class="q1">The <span class="nd">Lord</span> is my shepherd;</div><div class="q2">I shall not want.</div>',
    )
    expect(verseText(psalm)).toBe('The LORD is my shepherd; I shall not want.')
    expect(verseText(PASSAGE)).toBe(TEXT)
    expect(verseText(passage(''))).toBeNull()
  })

  test('reads every version\'s markup: small capitals, entities, the LSV\'s line marks', () => {
    // NASB and AMP set the divine name as L + small capitals; NIVUK sets all of it in them.
    const nasb = passage('<div class="q"><span class="yv-vlbl">1</span>The L<span class="sc">ord</span> is my shepherd,</div><div class="q">I shall not want.</div>')
    expect(verseText(nasb)).toBe('The LORD is my shepherd, I shall not want.')
    expect(verseText(passage('<div class="q1">The name of the <span class="sc">Lord</span> is a fortified tower;</div>'))).toBe(
      'The name of the LORD is a fortified tower;',
    )
    const words = passage('<div class="p"><span class="yv-vlbl">16</span> <span class="wj">“For God so</span> [greatly] <span class="wj">loved <span class="it">and</span> dearly prized the world</span></div>')
    expect(verseText(words)).toBe('“For God so [greatly] loved and dearly prized the world')
    expect(verseText(passage('<div class="p">Don&#39;t worry &amp; don&#x2019;t fear</div>'))).toBe('Don\'t worry & don’t fear')
    expect(verseText(passage('<div class="p">But those expecting YHWH pass [to] power, || They raise up the pinion as eagles</div>'))).toBe(
      'But those expecting YHWH pass [to] power, They raise up the pinion as eagles',
    )
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
    expect(after('Matthew 5:16')).toBe('Proverbs 3:5')
    expect(after('Philippians 4:19')).toBe('Romans 8:28')
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
    expect(await busy.find({ type: 'Text', text: /^From/ })).toBeDefined()
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

  test('Share says Copied for a moment', async ($, on) => {
    const { clock } = world(on)
    await turns($, 1)
    const busy = await $.ui.mount({ ...band(true), surface: 'terminal' })
    const label = async () => (await busy.find({ key: 'share' }))?.props.label
    expect(await label()).toBe('Share')
    await busy.press({ key: 'share' })
    expect(await label()).toBe('Copied')
    await clock.advance(2_000)
    expect(await label()).toBe('Share')
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
    expect(await busy.find({ type: 'Text', text: new RegExp(swapped.ref) })).toBeDefined()
    expect(await busy.find({ type: 'Text', text: /Read it slowly/ })).toBeDefined()
  })

  test('anything else shows the usage', async ($, on) => {
    world(on)
    expect(await wait($, 'nope')).toContain('/wait hide [today]')
  })
})

describe('version', () => {
  const niv = otherPassage(passageUrl(VERSE, 111))
  const nivText = verseText(niv)!

  test('the version in the band opens the picker, and a pick reads today\'s verse in it at the same step', async ($, on) => {
    const { copied, panes } = world(on)
    await turns($, 10)
    const busy = await $.ui.mount({ ...band(true), surface: 'terminal' })
    expect((await busy.find({ key: 'version' }))?.props.label).toBe('BSB')
    await busy.press({ key: 'version' })
    expect(panes).toEqual(['version'])

    for (const surface of ['terminal', 'desktop'] as const) {
      const pane = await $.ui.mount({ ...picker, surface })
      expect((await pane.find({ key: 'version-3034' }))?.props.label).toStartWith('✓ BSB')
      expect((await pane.find({ key: 'version-111' }))?.props.label).toStartWith('  NIV')
      expect(await pane.find({ type: 'Text', text: /public domain/ })).toBeDefined()
      await pane.unmount()
    }
    const pane = await $.ui.mount({ ...picker, surface: 'terminal' })
    await pane.press({ key: 'version-111' })
    expect(panes).toEqual([])

    const after = await $.ui.mount({ ...band(true), surface: 'terminal' })
    expect((await after.find({ key: 'version' }))?.props.label).toBe('NIV')
    expect(await after.find({ type: 'Text', text: /Fill in the blanks/ })).toBeDefined()
    expect(await wait($)).toContain('10 looks today')
    expect(await wait($)).toContain('Biblica')
    await wait($, 'copy')
    expect(copied).toEqual([`“${nivText}” — ${VERSE.ref} (NIV)`])
  })

  test('/wait version names one, and the days after come in it', async ($, on) => {
    const { clock, fetched } = world(on)
    await turns($, 1)
    expect(await wait($, 'version NASB')).toContain('New American Standard Bible (NASB)')
    await clock.set(NOON + DAY)
    await turns($, 1)
    const tomorrow = verseFor('2026-10-03')
    expect(await wait($)).toContain(`${tomorrow.ref} (NASB)`)
    expect(fetched.at(-1)).toBe(passageUrl(tomorrow, 2692))
  })

  test('/wait version alone opens the picker, and an unknown name lists the versions', async ($, on) => {
    const { panes } = world(on)
    await turns($, 1)
    expect(await wait($, 'version')).toContain('/wait version niv')
    expect(panes).toEqual(['version'])
    const list = await wait($, 'version kjv')
    expect(list).toContain('no version called kjv')
    expect(list).toContain('✓ BSB')
    expect(list).toContain('NIV')
  })

  test('a version that can\'t be fetched leaves the verse as it was', async ($, on) => {
    world(on, {}, {}, { down: [111] })
    await turns($, 1)
    expect(await wait($, 'version niv')).toContain("Couldn't reach")
    expect(await wait($)).toContain(`${VERSE.ref} (BSB)`)
    expect(await wait($)).toContain(TEXT)
  })

  test('a verse saved before versions is the BSB', async ($, on) => {
    world(on, { today: { day: '2026-10-02', ref: VERSE.ref, text: TEXT, views: 3, isMastered: false } })
    await turns($, 1)
    const busy = await $.ui.mount({ ...band(true), surface: 'terminal' })
    expect((await busy.find({ key: 'version' }))?.props.label).toBe('BSB')
    expect(await wait($)).toContain('4 looks today')
  })
})

describe('usage count', () => {
  test('an install, then one active day at a time with the day before', async ($, on) => {
    const { clock, posts } = world(on)
    await session($)
    await clock.advance(5_000)
    expect(posts).toEqual([
      { e: 'install', client: 'plugin', v: '0.3.8', platform: 'terminal', app: 'claude-code', installed: '2026-10-02', day: '2026-10-02' },
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
