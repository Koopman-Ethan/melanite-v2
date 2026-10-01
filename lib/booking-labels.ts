// What to show where a client's name used to be.
//
// Under the rental model Melanite books laser time to a provider and never learns who the client
// is — that was Keoni's reason for the change, not a side effect of it. So `bookings.clientName`
// is nullable, and every surface that used to print it needs something to print instead.
//
// ONE PHRASE, not a choice made separately in each view. A calendar saying "—", a digest saying
// "(no client)" and an appointment list saying "Unknown" would read as three different facts
// about the same booking, and "unknown" is the wrong one: nobody failed to record the name, it
// was deliberately never asked for.

/** Shown wherever a rental booking appears in a list of appointments. */
export const NO_CLIENT_LABEL = 'Provider’s client'

/** The client's name, or the stand-in for a booking that never had one. */
export function clientLabel(name: string | null | undefined): string {
  return name?.trim() || NO_CLIENT_LABEL
}
