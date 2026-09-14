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
// the room will not.
//
// v1 let anybody sign off having ticked nothing, on the theory that a truthful partial record
// beats a coerced full one. Testing found the obvious hole: a signed certification saying the
// suite was left clean, with zero items ticked behind it. Twenty items are now REQUIRED and five
// remain conditional, because those five describe things that may genuinely not have happened and
// requiring them would force a provider to tick a lie.
//
// Source: "Melanite Laser Suite - Provider End-of-Use Checklist", September 2026.

/** Bump when the WORDING changes in a way that alters what somebody is attesting to.
 *
 *  Not for a typo. Past rows keep the version they were signed against, so an old row stays
 *  readable as what it actually said.
 *
 *  v2 made twenty of the twenty-five items REQUIRED. The wording did not change, but what a
 *  signature MEANS did: under v1 a provider could sign off having ticked nothing, which is what
 *  testing found and why v2 exists. Bumping keeps those two kinds of row telling apart. */
export const END_OF_USE_VERSION = '2026-09-14.v2'

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
  /**
   * Must this be ticked before anybody can sign off?
   *
   * FALSE means the item describes something that may genuinely not have happened — no eyewear
   * was damaged, no supplies ran short, there were no adverse events. Requiring those would force
   * a provider to tick a lie, and a record built out of lies is worse than no record. The
   * document itself says "(if applicable)" on one of them.
   *
   * TRUE means it applies to every session and a close-out without it is not a close-out. This is
   * enforced on the SERVER, not merely by a disabled button — the button is a courtesy and the
   * action is the rule.
   */
  required: boolean
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
      { key: 'laser_standby', label: 'Return laser to standby mode', required: true },
      {
        key: 'laser_power_down',
        label: 'Power down laser system',
        // REQUIRED, and it is the one item here that is sometimes wrong. June's wording said "if
        // last provider of the day"; September's dropped the condition, the checklist is offered
        // after every appointment, and required was chosen deliberately over making it conditional
        // or tying it to `afterNeededGiven`. A provider with somebody booked after them should not
        // actually power the machine down — the hint is the whole mitigation, and if providers
        // start ticking it untruthfully that is the signal to revisit.
        hint: 'If somebody is booked after you, leave it in standby — tick this once it is set as you are leaving it.',
        required: true,
      },
      {
        key: 'laser_inspect_handpieces',
        label: 'Inspect handpieces for damage or debris',
        required: true,
      },
      {
        key: 'laser_wipe_handpiece',
        label: 'Wipe handpiece exterior with approved alcohol disinfectant',
        required: true,
      },
      {
        key: 'laser_clean_window',
        label: 'Clean treatment window/tip according to manufacturer guidelines',
        required: true,
      },
      {
        key: 'laser_remove_gel',
        label: 'Remove any remaining gel from handpiece and treatment surfaces',
        required: true,
      },
      {
        key: 'laser_store_handpieces',
        label: 'Confirm handpieces are properly stored in holders',
        required: true,
      },
      {
        key: 'laser_secure_cords',
        label: 'Ensure cords and cables are neatly secured',
        required: true,
      },
    ],
  },
  {
    key: 'eyewear',
    title: 'Safety Eyewear',
    items: [
      {
        key: 'eyewear_disinfect',
        label: 'Disinfect all patient and provider safety eyewear with alcohol wipes',
        required: true,
      },
      {
        key: 'eyewear_store',
        label: 'Return eyewear to designated storage location',
        required: true,
      },
      {
        key: 'eyewear_inspect',
        label: 'Inspect eyewear for scratches, cracks, or damage',
        required: true,
      },
      {
        key: 'eyewear_report_damage',
        label: 'Report damaged eyewear immediately',
        // Conditional: you cannot report damage that does not exist. Requiring it would mean a
        // provider ticks it on every sound pair of glasses, and the one session where it MEANT
        // something would be indistinguishable from the other forty.
        hint: 'Only if you found damage. Leave it if the eyewear was sound.',
        required: false,
      },
    ],
  },
  {
    key: 'room',
    title: 'Treatment Room',
    items: [
      {
        key: 'room_dispose_consumables',
        label: 'Dispose of all treatment consumables',
        required: true,
      },
      {
        key: 'room_remove_used_items',
        label: 'Remove used gauze, towels, gloves, and applicators',
        required: true,
      },
      {
        key: 'room_clean_bed',
        label: 'Clean treatment bed/chair with approved disinfectant',
        required: true,
      },
      {
        key: 'room_clean_counters',
        label: 'Clean countertops and treatment trays',
        required: true,
      },
      {
        key: 'room_clean_touched',
        label: 'Clean any touched surfaces (door handles, laser controls, stool, etc.)',
        required: true,
      },
      { key: 'room_remove_personal', label: 'Remove all personal items', required: true },
      {
        key: 'room_presentation',
        label: 'Return room to professional presentation standard',
        required: true,
      },
    ],
  },
  {
    key: 'supplies',
    title: 'Supplies',
    items: [
      { key: 'supplies_restock', label: 'Restock supplies used', required: true },
      {
        key: 'supplies_notify_shortage',
        label: 'Notify management of any supply shortages',
        // Conditional: most sessions run nothing short. Ticking it is the notification, so the
        // form points at the notes box — "we are low on something" that does not say what is a
        // message Keoni cannot act on.
        hint: 'Only if something ran short — say which in the notes at the bottom.',
        required: false,
      },
    ],
  },
  {
    key: 'docs',
    title: 'Documentation',
    items: [
      { key: 'docs_treatment', label: 'Complete treatment documentation', required: true },
      {
        key: 'docs_photos',
        label: 'Save before-and-after photos (if applicable)',
        // NOT the laser photographs, and never derived from them. These are the client's treatment
        // photos, which live in their chart and which this app is forbidden from holding —
        // `lib/blob.ts` says plainly what would have to change first. Ticking this automatically
        // because somebody photographed the MACHINE would assert something the app has no
        // knowledge of, on the one record whose entire value is being trustworthy.
        //
        // Conditional because the document itself says "(if applicable)".
        hint: 'Your client photos, in their chart — not the laser. Leave it if there were none.',
        required: false,
      },
      {
        key: 'docs_adverse_events',
        label: 'Document any adverse events',
        // Conditional, and requiring it would be actively harmful: a provider forced to tick
        // "documented any adverse events" after an uneventful session learns that the tick means
        // nothing, which is exactly the habit you do not want on this item.
        hint: 'Only if something happened. Leave it if nothing did.',
        required: false,
      },
      {
        key: 'docs_device_concerns',
        label: 'Document any device concerns or errors',
        hint: 'Only if there was something to record — the device question below is where it reaches Melanite.',
        required: false,
      },
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

/** Every item that must be ticked before anybody can sign off. */
export const REQUIRED_ITEMS: readonly EndOfUseItem[] = END_OF_USE_ITEMS.filter((i) => i.required)

/** 20. Derived, never written down, for the same reason `END_OF_USE_ITEM_COUNT` is. */
export const REQUIRED_ITEM_COUNT = REQUIRED_ITEMS.length

/** The document's own sentence.
 *
 *  Shown unconditionally now, because it is TRUE for anything that can be submitted: the required
 *  twenty are done, and the five that are not ticked are the ones that did not apply. There is no
 *  longer a partial state to hedge for — under v1 there was, which is what made a second,
 *  weaker certification sentence necessary and is the hole this replaced. */
export const END_OF_USE_CERTIFICATION =
  'I certify that I have completed the above checklist and have left the laser suite and equipment in clean, safe, and operational condition.'

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

/**
 * The required items still not ticked.
 *
 * The list, not a count — the form names them, because "you have missed 3 of 20" sends somebody
 * scrolling to find which.
 */
export function missingRequired(ticked: readonly string[]): EndOfUseItem[] {
  const done = new Set(ticked)
  return REQUIRED_ITEMS.filter((i) => !done.has(i.key))
}

/**
 * May this be signed off?
 *
 * Every required item ticked. The conditional five are ignored entirely: not ticking them IS the
 * answer, and there is no way to tell "did not apply" from "did not do it" for an item that only
 * sometimes exists — which is precisely why they are not required.
 *
 * Called on the SERVER as well as in the form. A disabled button is a courtesy to whoever is
 * standing in the room; it is not a rule, and anything that only a button enforces is not enforced.
 */
export function canSignOff(ticked: readonly string[]): boolean {
  return missingRequired(ticked).length === 0
}
