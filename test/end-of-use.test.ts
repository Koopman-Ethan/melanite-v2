import { describe, expect, it } from 'vitest'

import {
  DEVICE_ISSUE_NOTE_MAX,
  END_OF_USE_ITEMS,
  END_OF_USE_ITEM_COUNT,
  END_OF_USE_SECTIONS,
  REQUIRED_ITEM_COUNT,
  canSignOff,
  deviceIssueError,
  isComplete,
  labelsFor,
  missingKeys,
  missingRequired,
  sanitiseItems,
} from '@/lib/end-of-use'

// The checklist a provider signs, and the rules around what that signature means.
//
// Pure logic, no database. The most valuable test in this file is the frozen key list: those
// strings are stored on every row ever written, so a rename is not a refactor — it silently
// rewrites what past providers declared. A red test is the only thing standing between a tidy-up
// and a falsified record.

/** Every key, written out by hand ON PURPOSE.
 *
 *  Deriving this from the module would make the test pass for any list, which is the one thing it
 *  must not do. If this fails, do not update it to match the code — work out whether the key was
 *  renamed, and if it was, rename it back and add a new item instead. */
const FROZEN_KEYS = [
  'laser_standby',
  'laser_power_down',
  'laser_inspect_handpieces',
  'laser_wipe_handpiece',
  'laser_clean_window',
  'laser_remove_gel',
  'laser_store_handpieces',
  'laser_secure_cords',
  'eyewear_disinfect',
  'eyewear_store',
  'eyewear_inspect',
  'eyewear_report_damage',
  'room_dispose_consumables',
  'room_remove_used_items',
  'room_clean_bed',
  'room_clean_counters',
  'room_clean_touched',
  'room_remove_personal',
  'room_presentation',
  'supplies_restock',
  'supplies_notify_shortage',
  'docs_treatment',
  'docs_photos',
  'docs_adverse_events',
  'docs_device_concerns',
]

describe('the item list, frozen', () => {
  it('has exactly the keys it has always had, in order', () => {
    expect(END_OF_USE_ITEMS.map((i) => i.key)).toEqual(FROZEN_KEYS)
  })

  it('counts 25 — not the 27 boxes on the paper form', () => {
    // The document draws the two Device Issues options as checkboxes. They are one either/or
    // answer, so they are a radio here and not part of the tick denominator. A provider who
    // counts the boxes on screen must get the same number the app shows them.
    expect(END_OF_USE_ITEM_COUNT).toBe(25)
    expect(END_OF_USE_ITEMS).toHaveLength(25)
  })

  it('matches the document section by section', () => {
    expect(END_OF_USE_SECTIONS.map((s) => [s.title, s.items.length])).toEqual([
      ['Laser Device Care', 8],
      ['Safety Eyewear', 4],
      ['Treatment Room', 7],
      ['Supplies', 2],
      ['Documentation', 4],
    ])
  })

  it('never repeats a key', () => {
    expect(new Set(FROZEN_KEYS).size).toBe(FROZEN_KEYS.length)
  })

  it('gives every item a non-empty label', () => {
    for (const item of END_OF_USE_ITEMS) {
      expect(item.label.trim(), `${item.key} has no label`).not.toBe('')
    }
  })

  it('does not claim the client-photo item is about the laser', () => {
    // Guards a specific wrong turn taken during design: pre-ticking this from the equipment
    // photographs. Those are pictures of the MACHINE. This item is the client's before-and-after
    // photos, which live in their chart and which this app is forbidden from holding. Anything
    // that derives it from equipment state asserts something nobody told us.
    const photos = END_OF_USE_ITEMS.find((i) => i.key === 'docs_photos')
    expect(photos?.hint).toMatch(/chart/i)
    expect(photos?.hint).toMatch(/not the laser/i)
  })
})

/** The five items a provider may legitimately leave unticked, frozen like the keys are.
 *
 *  Moving an item between required and conditional changes what a signature MEANS, so it belongs
 *  in a reviewed commit with this list edited alongside — not a quiet one-character diff. */
const CONDITIONAL_KEYS = [
  'eyewear_report_damage',
  'supplies_notify_shortage',
  'docs_photos',
  'docs_adverse_events',
  'docs_device_concerns',
]

describe('required and conditional', () => {
  it('requires twenty and leaves five conditional', () => {
    expect(REQUIRED_ITEM_COUNT).toBe(20)
    expect(END_OF_USE_ITEM_COUNT - REQUIRED_ITEM_COUNT).toBe(5)
  })

  it('leaves exactly the five that may genuinely not have happened', () => {
    // Requiring any of these forces a provider to tick a lie on an uneventful session — nothing
    // damaged, nothing short, no adverse event — and a record built out of those is worse than no
    // record. The document itself says "(if applicable)" on the photos item.
    expect(END_OF_USE_ITEMS.filter((i) => !i.required).map((i) => i.key)).toEqual(CONDITIONAL_KEYS)
  })

  it('requires powering the laser down', () => {
    // Chosen deliberately over conditional, knowing it is wrong whenever somebody is booked after
    // you. Pinned so the decision has to be re-made rather than drifting.
    expect(END_OF_USE_ITEMS.find((i) => i.key === 'laser_power_down')?.required).toBe(true)
  })

  it('tells a provider when each conditional item applies', () => {
    // An item marked "if applicable" with no hint is a coin flip.
    for (const item of END_OF_USE_ITEMS.filter((i) => !i.required)) {
      expect(item.hint, `${item.key} is conditional but never says when it applies`).toBeTruthy()
    }
  })
})

describe('canSignOff', () => {
  const allRequired = END_OF_USE_ITEMS.filter((i) => i.required).map((i) => i.key)

  it('refuses a close-out with nothing ticked', () => {
    // The hole found in testing: v1 accepted exactly this and certified that the suite had been
    // left clean, safe and operational.
    expect(canSignOff([])).toBe(false)
    expect(missingRequired([])).toHaveLength(20)
  })

  it('refuses when one required item is missing', () => {
    expect(canSignOff(allRequired.slice(0, 19))).toBe(false)
    expect(missingRequired(allRequired.slice(0, 19)).map((i) => i.key)).toEqual([allRequired[19]])
  })

  it('allows the required twenty with no conditionals ticked', () => {
    // The ordinary case: an uneventful session, nothing damaged and nothing short.
    expect(canSignOff(allRequired)).toBe(true)
  })

  it('allows all twenty-five', () => {
    expect(canSignOff(END_OF_USE_ITEMS.map((i) => i.key))).toBe(true)
  })

  it('is not satisfied by ticking conditionals instead', () => {
    // Twenty ticks is not the bar. The right twenty is.
    expect(canSignOff([...CONDITIONAL_KEYS, ...allRequired.slice(0, 15)])).toBe(false)
  })

  it('names what is outstanding, in document order', () => {
    const missing = missingRequired(allRequired.slice(2))
    expect(missing.map((i) => i.key)).toEqual(allRequired.slice(0, 2))
    expect(missing[0].label).toBeTruthy()
  })
})

describe('sanitiseItems', () => {
  it('drops keys it does not recognise', () => {
    // A retired key must never resurrect, and a hand-crafted POST must not be able to invent one.
    expect(sanitiseItems(['laser_standby', 'not_a_real_key'])).toEqual(['laser_standby'])
  })

  it('de-duplicates', () => {
    expect(sanitiseItems(['eyewear_store', 'eyewear_store'])).toEqual(['eyewear_store'])
  })

  it('returns document order regardless of the order submitted', () => {
    expect(sanitiseItems(['docs_treatment', 'laser_standby', 'room_clean_bed'])).toEqual([
      'laser_standby',
      'room_clean_bed',
      'docs_treatment',
    ])
  })

  it('accepts an empty submission', () => {
    // Ticking nothing is a truthful answer and the loudest line in the digest. It is not an error.
    expect(sanitiseItems([])).toEqual([])
  })
})

describe('missingKeys and labelsFor', () => {
  it('names what was not ticked', () => {
    const missing = missingKeys(FROZEN_KEYS.filter((k) => k !== 'eyewear_disinfect'))
    expect(missing).toEqual(['eyewear_disinfect'])
    expect(labelsFor(missing)).toEqual([
      'Disinfect all patient and provider safety eyewear with alcohol wipes',
    ])
  })

  it('returns everything when nothing was ticked', () => {
    expect(missingKeys([])).toHaveLength(25)
  })

  it('returns nothing when everything was ticked', () => {
    expect(missingKeys(FROZEN_KEYS)).toEqual([])
  })

  it('skips a key this build no longer has rather than rendering it raw', () => {
    // A row signed against an older version can name a retired item. "laser_old_thing" in an
    // email to Keoni is worse than one fewer line.
    expect(labelsFor(['laser_standby', 'laser_retired_item'])).toEqual([
      'Return laser to standby mode',
    ])
  })
})

describe('isComplete', () => {
  it('is true when the row met its own list', () => {
    expect(isComplete({ completedItems: FROZEN_KEYS, itemCount: 25 })).toBe(true)
  })

  it('is false one item short', () => {
    expect(isComplete({ completedItems: FROZEN_KEYS.slice(0, 24), itemCount: 25 })).toBe(false)
  })

  it('keeps an old complete row complete after the list grows', () => {
    // The whole reason `itemCount` is stored rather than looked up. Somebody who ticked all 25
    // signed a complete checklist, and adding a 26th item later must not retroactively turn their
    // record into a partial one.
    expect(isComplete({ completedItems: FROZEN_KEYS, itemCount: 25 })).toBe(true)
  })

  it('is false for a row with nothing ticked', () => {
    expect(isComplete({ completedItems: [], itemCount: 25 })).toBe(false)
  })
})

describe('deviceIssueError', () => {
  it('refuses a reported issue that says nothing', () => {
    // "Something is wrong with the laser" naming nothing is a message nobody can act on.
    expect(deviceIssueError(true, '')).toMatch(/what is wrong/i)
    expect(deviceIssueError(true, '   ')).toMatch(/what is wrong/i)
  })

  it('refuses a note longer than the cap', () => {
    expect(deviceIssueError(true, 'x'.repeat(DEVICE_ISSUE_NOTE_MAX + 1))).toMatch(/under/i)
  })

  it('refuses a note filed against "no issues"', () => {
    expect(deviceIssueError(false, 'the handpiece is cracked')).toMatch(/Device issue reported/i)
  })

  it('accepts both honest answers', () => {
    expect(deviceIssueError(false, '')).toBeNull()
    expect(deviceIssueError(true, 'Handpiece window is chipped')).toBeNull()
    expect(deviceIssueError(true, 'x'.repeat(DEVICE_ISSUE_NOTE_MAX))).toBeNull()
  })
})
