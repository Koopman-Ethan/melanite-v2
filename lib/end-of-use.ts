// What a provider says they did before leaving the laser suite, and which wording they said it
// against.
//
// The list lives in code for the same reason `lib/equipment-policy.ts` and
// `lib/room-procedures.ts` do: this is what somebody signs their name to, and changing it should
// be a reviewed commit rather than a form field edited on a Tuesday.
//
// VERSIONED, and the keys are STABLE. Those are two different guarantees and both matter. The
// version stamps which wording a provider ticked against, so a later rewrite cannot silently
// restate what they attested to. The keys are the identity of an item across rewordings — change
// one and you have rewritten what every past provider declared, which is the same warning
// `RoomProcedure.key` carries.
//
// THIS IS A RECORD, NOT AN INTERLOCK. Nothing here stops anybody using the laser or leaving the
// room, exactly as the photographs cannot. `docs/decisions.md` is explicit about what actually
// decides whether these get filled in honestly: a provider who reads it as surveillance will tick
// everything without looking, and a provider who reads it as their own account of how they left
// the room will not. Partial submission is legitimate for that reason — see
// `END_OF_USE_PARTIAL_CERTIFICATION`.
//
// Source: "Melanite Laser Suite - Provider End-of-Use Checklist", September 2026.

/** Bump when the WORDING changes in a way that alters what somebody is attesting to.
 *
 *  Not for a typo. Past rows keep the version they were signed against, so an old row stays
 *  readable as what it actually said. */
export const END_OF_USE_VERSION = '2026-09-11.v1'

/** When providers were first asked to close the suite out.
 *
 *  Sessions before it have no close-out and nobody could have filed one, so listing them as
 *  exceptions is noise. The same reasoning — and the same mistake already made once — as
 *  `EQUIPMENT_LOG_STARTED_AT`: the equipment page first loaded with sixteen unfixable rows on it,
 *  which is how a page becomes one nobody opens twice. */
export const END_OF_USE_STARTED_AT = new Date('2026-09-12T00:00:00-06:00')

export interface EndOfUseItem {
  /** Stored on the checklist row. Kept stable — changing one rewrites what past providers
   *  declared. */
  key: string
  /** The document's wording, verbatim. This is what they are ticking. */
  label: string
  /** Shown smaller, under the label. Never part of what is attested to — it exists to stop an
   *  item being read as something it is not. */
  hint?: string
}

export interface EndOfUseSection {
  key: string
  title: string
  items: readonly EndOfUseItem[]
}

/**
 * The five sections of tickable work, in the document's order.
 *
 * Device Issues is the document's sixth section and is deliberately NOT here: it is a
 * mutually-exclusive pair rather than two independent ticks, so it is a required radio in the
 * form and a boolean on the row. Counting it as two checkboxes is where "27" comes from on paper
 * and it is not a number that should ever appear in this app — see `END_OF_USE_ITEM_COUNT`.
 */
export const END_OF_USE_SECTIONS: readonly EndOfUseSection[] = [
  {
    key: 'laser',
    title: 'Laser Device Care',
    items: [
      { key: 'laser_standby', label: 'Return laser to standby mode' },
      {
        key: 'laser_power_down',
        label: 'Power down laser system',
        // The June wording of this document said "if last provider of the day", and September's
        // dropped it. The checklist is offered after every appointment, so this item is wrong
        // whenever somebody follows you in. Keeping the document's wording was a deliberate
        // decision; the hint is what stops it reading as an instruction to strand the next
        // provider. If this becomes a real problem the fix is an `onlyWhenLastUse` flag on the
        // item and `afterNeededGiven` at the call site — the keys are stable, so that is a
        // change to this list and not a migration.
        hint: 'If somebody is booked after you, leave it in standby instead.',
      },
      { key: 'laser_inspect_handpieces', label: 'Inspect handpieces for damage or debris' },
      {
        key: 'laser_wipe_handpiece',
        label: 'Wipe handpiece exterior with approved alcohol disinfectant',
      },
      {
        key: 'laser_clean_window',
        label: 'Clean treatment window/tip according to manufacturer guidelines',
      },
      {
        key: 'laser_remove_gel',
        label: 'Remove any remaining gel from handpiece and treatment surfaces',
      },
      { key: 'laser_store_handpieces', label: 'Confirm handpieces are properly stored in holders' },
      { key: 'laser_secure_cords', label: 'Ensure cords and cables are neatly secured' },
    ],
  },
  {
    key: 'eyewear',
    title: 'Safety Eyewear',
    items: [
      {
        key: 'eyewear_disinfect',
        label: 'Disinfect all patient and provider safety eyewear with alcohol wipes',
      },
      { key: 'eyewear_store', label: 'Return eyewear to designated storage location' },
      { key: 'eyewear_inspect', label: 'Inspect eyewear for scratches, cracks, or damage' },
      { key: 'eyewear_report_damage', label: 'Report damaged eyewear immediately' },
    ],
  },
  {
    key: 'room',
    title: 'Treatment Room',
    items: [
      { key: 'room_dispose_consumables', label: 'Dispose of all treatment consumables' },
      { key: 'room_remove_used_items', label: 'Remove used gauze, towels, gloves, and applicators' },
      { key: 'room_clean_bed', label: 'Clean treatment bed/chair with approved disinfectant' },
      { key: 'room_clean_counters', label: 'Clean countertops and treatment trays' },
      {
        key: 'room_clean_touched',
        label: 'Clean any touched surfaces (door handles, laser controls, stool, etc.)',
      },
      { key: 'room_remove_personal', label: 'Remove all personal items' },
      { key: 'room_presentation', label: 'Return room to professional presentation standard' },
    ],
  },
  {
    key: 'supplies',
    title: 'Supplies',
    items: [
      { key: 'supplies_restock', label: 'Restock supplies used' },
      { key: 'supplies_notify_shortage', label: 'Notify management of any supply shortages' },
    ],
  },
  {
    key: 'docs',
    title: 'Documentation',
    items: [
      { key: 'docs_treatment', label: 'Complete treatment documentation' },
      {
        key: 'docs_photos',
        label: 'Save before-and-after photos (if applicable)',
        // NOT the laser photographs, and never derived from them. These are the client's
        // treatment photos, which live in their chart and which this app is forbidden from
        // holding — `lib/blob.ts` says plainly what would have to change first. Ticking this
        // automatically because somebody photographed the MACHINE would assert something the app
        // has no knowledge of, on the one record whose entire value is being trustworthy.
        hint: 'Your client photos, in their chart — not the laser.',
      },
      { key: 'docs_adverse_events', label: 'Document any adverse events' },
      { key: 'docs_device_concerns', label: 'Document any device concerns or errors' },
    ],
  },
] as const

/** Every item, flattened, in document order. */
export const END_OF_USE_ITEMS: readonly EndOfUseItem[] = END_OF_USE_SECTIONS.flatMap(
  (s) => s.items,
)

/** 25. Derived rather than written down, so it cannot disagree with the list above.
 *
 *  The paper form has 27 boxes because it draws the two Device Issues options as checkboxes.
 *  They are one either/or answer, so the tick denominator is 25 — and a count shown to a provider
 *  has to be arithmetically true or the first person who counts stops believing the record. */
export const END_OF_USE_ITEM_COUNT = END_OF_USE_ITEMS.length

const ITEM_BY_KEY = new Map(END_OF_USE_ITEMS.map((i) => [i.key, i]))

/** The document's own sentence, shown only when every item is ticked. */
export const END_OF_USE_CERTIFICATION =
  'I certify that I have completed the above checklist and have left the laser suite and equipment in clean, safe, and operational condition.'

/** What is honest to sign when some of it was not done.
 *
 *  Swapping the sentence rather than blocking the button is the whole design: forcing all
 *  twenty-five before anything can be saved produces a reflexive tick-through, which destroys
 *  exactly the signal this feature exists to collect. A partial record that is TRUE is worth more
 *  than a complete one that is not. */
export const END_OF_USE_PARTIAL_CERTIFICATION =
  'I certify that I completed the items I have ticked, and that the ones I have not ticked were not done.'

/** Reference only — never tickable, never stored.
 *
 *  These reach Melanite immediately by other means (flag the photograph, or a phone call). Listing
 *  them at the foot of the form is what stops somebody filing a burn as a checklist note and
 *  assuming it has been dealt with. */
export const IMMEDIATE_REPORTING: readonly string[] = [
  'Damaged handpieces',
  'Cracked or scratched eyewear',
  'Error codes on laser system',
  'Missing supplies',
  'Adverse patient events',
  'Burns, blisters, or unexpected treatment reactions',
  'Any dropped or contaminated equipment',
] as const

/** Longest a device-issue note may be. Long enough to describe a fault, short enough that nobody
 *  writes a case note in it. */
export const DEVICE_ISSUE_NOTE_MAX = 500

/**
 * The submitted keys, cleaned: unknown keys dropped, duplicates removed, document order restored.
 *
 * Unknown keys are DROPPED rather than rejected. A key that no longer exists means the list
 * changed between the page rendering and the form posting, and refusing somebody's whole
 * close-out because an item was retired mid-submission would be the wrong failure — the same
 * forgiveness `requiresMedicalDirection` shows for renamed procedure keys.
 */
export function sanitiseItems(keys: readonly string[]): string[] {
  const seen = new Set(keys)
  return END_OF_USE_ITEMS.filter((i) => seen.has(i.key)).map((i) => i.key)
}

/** Which items were NOT ticked. The absence is the signal — it is what Keoni is reading. */
export function missingKeys(completed: readonly string[]): string[] {
  const done = new Set(completed)
  return END_OF_USE_ITEMS.filter((i) => !done.has(i.key)).map((i) => i.key)
}

/** Labels for keys, for showing back to a provider or to Keoni.
 *
 *  Unknown keys are skipped rather than rendered raw: a row signed against an older version can
 *  name an item this build no longer has, and `laser_old_thing` in an email is worse than one
 *  fewer line. */
export function labelsFor(keys: readonly string[]): string[] {
  return keys.map((k) => ITEM_BY_KEY.get(k)?.label).filter((l): l is string => Boolean(l))
}

/**
 * Was everything on the list they were shown ticked?
 *
 * Compares against the row's OWN `itemCount`, not today's `END_OF_USE_ITEM_COUNT`. A close-out
 * signed as 25 of 25 must keep reading as complete after a twenty-sixth item is added, because it
 * was complete — against the list that existed when somebody signed it.
 */
export function isComplete(row: { completedItems: readonly string[]; itemCount: number }): boolean {
  return row.completedItems.length >= row.itemCount
}

/**
 * Validates the device-issue answer.
 *
 * There is no default and no "unanswered": the form will not submit without one of the two, and
 * this is the answer with a same-day consequence. A reported issue with no description is the
 * failure worth guarding — "something is wrong with the laser" that names nothing is a message
 * nobody can act on.
 */
export function deviceIssueError(reported: boolean, note: string): string | null {
  const trimmed = note.trim()
  if (reported && !trimmed) return 'Say what is wrong with the machine.'
  if (reported && trimmed.length > DEVICE_ISSUE_NOTE_MAX) {
    return `Keep that under ${DEVICE_ISSUE_NOTE_MAX} characters.`
  }
  if (!reported && trimmed) return 'Choose "Device issue reported" if there is something to report.'
  return null
}
