// Which procedures performed in the rented room require a medical director.
//
// The app cannot observe what happens in that room — a room renter brings their own clients and
// bills them directly, so none of it touches this system. Asking "do you need a medical
// director?" would put Idaho's supervision rules in the provider's head, where most will guess,
// and "no" is unfalsifiable so nothing could be gated on it.
//
// So they declare what they intend to PERFORM, and the app applies Melanite's rule. Three
// benefits: the rule lives in one place and changes once; it is enforceable, because a
// declaration of a supervised procedure with no director on file can block room rental; and it
// is a real record — "she told us on 14 September she would be doing injections" is defensible
// in a way that a ticked box is not.
//
// The list is the SUPERVISED list, not a catalogue of everything anybody does in that room.
// Anything not named here does not require supervision, which is why it can stay short.
//
// From Keoni, 31 July 2026. Extending it is a code change on purpose: this is medical policy,
// and it should be reviewed rather than edited in a form field.

export interface RoomProcedure {
  /** Stored on the provider. Kept stable — changing one rewrites what past providers declared. */
  key: string
  label: string
}

export const SUPERVISED_PROCEDURES: readonly RoomProcedure[] = [
  { key: 'microneedling', label: 'Microneedling' },
  { key: 'injections', label: 'Injections' },
  { key: 'iv_therapy', label: 'IV therapy' },
] as const

const SUPERVISED_KEYS = new Set(SUPERVISED_PROCEDURES.map((p) => p.key))

/**
 * Does what they declared require a medical director?
 *
 * True if ANY declared procedure is on the supervised list. Unknown keys are ignored rather
 * than treated as supervised — a key that no longer exists means the list changed, and refusing
 * to let somebody rent a room because of a rename would be the wrong failure.
 *
 * An empty declaration is NOT the same as "no supervision needed": it means they have not
 * answered yet. Callers that care about the difference should check the declaration timestamp.
 */
export function requiresMedicalDirection(declared: readonly string[] | null): boolean {
  if (!declared) return false
  return declared.some((key) => SUPERVISED_KEYS.has(key))
}

/** The supervised procedures they declared, for showing back to them or to Keoni. */
export function supervisedLabels(declared: readonly string[] | null): string[] {
  if (!declared) return []
  return SUPERVISED_PROCEDURES.filter((p) => declared.includes(p.key)).map((p) => p.label)
}
