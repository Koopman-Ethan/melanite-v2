import { describe, expect, it } from 'vitest'

import {
  UNATTENDED_GAP_MINUTES,
  afterCheckNeeded,
  afterNeededGiven,
  checkWindowOpen,
  isUnbracketed,
} from '@/lib/equipment-checks'
import {
  EQUIPMENT_POLICY_VERSION,
  hasAcceptedEquipmentPolicy,
} from '@/lib/equipment-policy'

// When to ask a provider to photograph the laser.
//
// Pure rules, and the ones most worth pinning. Ask too often and the prompt becomes something
// people dismiss without reading, which costs the photographs that actually mattered; ask too
// rarely and a session goes unbracketed with nobody told. Neither failure raises an error.

const at = (h: number, m = 0) => new Date(Date.UTC(2026, 8, 14, h, m))
const slot = (id: string, startHour: number, minutes = 60) => ({
  id,
  startTime: at(startHour),
  endTime: new Date(at(startHour).getTime() + minutes * 60_000),
})

describe('afterCheckNeeded', () => {
  it('asks when nobody follows', () => {
    const only = slot('a', 9)
    expect(afterCheckNeeded(only, [only])).toBe(true)
  })

  it('does not ask when the next provider arrives soon after', () => {
    // Their arrival photo IS the after-photo of this session — nothing happens to the machine in
    // between. Asking anyway produces a photograph nothing will ever be compared against.
    const first = slot('a', 9)
    const second = slot('b', 11)
    expect(afterCheckNeeded(first, [first, second])).toBe(false)
  })

  it('asks when the gap is long enough that the laser is left alone', () => {
    const morning = slot('a', 9)
    const evening = slot('b', 17)
    expect(afterCheckNeeded(morning, [morning, evening])).toBe(true)
  })

  it('draws the line exactly at the configured gap', () => {
    const first = slot('a', 9) // ends 10:00
    const justInside = { ...slot('b', 12), startTime: at(10 + UNATTENDED_GAP_MINUTES / 60) }
    expect(afterCheckNeeded(first, [first, justInside])).toBe(false)

    const justOutside = { ...justInside, startTime: at(10 + UNATTENDED_GAP_MINUTES / 60, 1) }
    expect(afterCheckNeeded(first, [first, justOutside])).toBe(true)
  })

  it('always asks the LAST booking of the day, however busy the day was', () => {
    const a = slot('a', 9)
    const b = slot('b', 11)
    const c = slot('c', 13)
    expect(afterCheckNeeded(c, [a, b, c])).toBe(true)
  })

  it('ignores bookings that finished earlier', () => {
    // "Who follows me" is forward-looking. An earlier appointment must not be mistaken for cover.
    const early = slot('a', 8)
    const later = slot('b', 15)
    expect(afterCheckNeeded(later, [early, later])).toBe(true)
  })

  it('is not fooled by the order the day arrives in', () => {
    const a = slot('a', 9)
    const b = slot('b', 11)
    expect(afterCheckNeeded(a, [b, a])).toBe(false)
  })
})

describe('afterNeededGiven', () => {
  // The rule itself. `afterCheckNeeded` finds the next use from a day; the appointments list gets
  // it from a subquery because it cannot hold a day in memory. Two ways of answering "who follows
  // me", and this is the one definition of how long a gap has to be — tested here so the two
  // callers cannot drift apart on the threshold.
  const ends = at(10)

  it('asks when nothing follows', () => {
    expect(afterNeededGiven(ends, null)).toBe(true)
  })

  it('does not ask when the next use is soon', () => {
    expect(afterNeededGiven(ends, at(11))).toBe(false)
  })

  it('asks once the laser is left alone for long enough', () => {
    expect(afterNeededGiven(ends, at(16))).toBe(true)
  })

  it('agrees with the day-list version', () => {
    const first = slot('a', 9)
    const second = slot('b', 11)
    expect(afterCheckNeeded(first, [first, second])).toBe(
      afterNeededGiven(first.endTime, second.startTime),
    )
  })
})

describe('checkWindowOpen', () => {
  const booking = slot('a', 14) // 14:00–15:00

  it('opens before they arrive and stays open well after', () => {
    expect(checkWindowOpen(booking, at(13, 30))).toBe(true)
    expect(checkWindowOpen(booking, at(14, 30))).toBe(true)
    expect(checkWindowOpen(booking, at(20))).toBe(true)
  })

  it('is shut the day before', () => {
    // Not "is it today" — a prompt from midnight for a 2pm appointment is noise for fourteen
    // hours, and noise is what teaches somebody to stop reading prompts.
    expect(checkWindowOpen(booking, at(2))).toBe(false)
  })
})

describe('isUnbracketed', () => {
  const past = at(9)

  it('flags a used appointment with no arrival photo', () => {
    expect(isUnbracketed({ status: 'completed', endTime: past, hasBefore: false, now: at(20) })).toBe(true)
    expect(isUnbracketed({ status: 'upcoming', endTime: past, hasBefore: false, now: at(20) })).toBe(true)
  })

  it('is satisfied by an arrival photo', () => {
    expect(isUnbracketed({ status: 'completed', endTime: past, hasBefore: true, now: at(20) })).toBe(false)
  })

  it('never flags an appointment that did not happen', () => {
    // A cancelled or no-show booking never touched the laser, so there is nothing to account for.
    // These are also the two statuses the overlap constraint excludes, for the same reason.
    for (const status of ['cancelled', 'no_show']) {
      expect(isUnbracketed({ status, endTime: past, hasBefore: false, now: at(20) })).toBe(false)
    }
  })

  it('does not flag an appointment that has not finished yet', () => {
    expect(isUnbracketed({ status: 'upcoming', endTime: at(16), hasBefore: false, now: at(15) })).toBe(false)
  })
})

describe('the policy acknowledgement', () => {
  it('accepts only the current wording', () => {
    expect(hasAcceptedEquipmentPolicy(EQUIPMENT_POLICY_VERSION)).toBe(true)
  })

  it('asks again when the wording has moved on', () => {
    // The point of versioning it. Somebody who agreed to earlier terms has not agreed to these,
    // and treating "has a value" as "has agreed" is how a rewrite silently rewrites consent.
    expect(hasAcceptedEquipmentPolicy('2020-01-01.v1')).toBe(false)
    expect(hasAcceptedEquipmentPolicy(null)).toBe(false)
    expect(hasAcceptedEquipmentPolicy(undefined)).toBe(false)
    expect(hasAcceptedEquipmentPolicy('')).toBe(false)
  })
})
