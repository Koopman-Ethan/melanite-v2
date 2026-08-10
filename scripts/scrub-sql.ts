// WHAT COUNTS AS IDENTIFYING, in one place.
//
// Two callers need these statements and they need them differently:
//
//   - `scrub-dev.ts` runs them against a database that already exists, on demand.
//   - `refresh-dev.ts` runs them INSIDE the transaction that loads a fresh copy of production,
//     so that appdev is never, at any instant, serving real client details.
//
// The second cannot call the first — the statements have to be in its transaction, not on a
// separate connection afterwards. So they live here, and neither file owns a second copy. A
// duplicate would drift the first time a column was added, and it would do it silently: the
// nightly copy would simply stop scrubbing whatever the other copy had learned about.
//
// WHAT IS NOT TOUCHED, deliberately:
//   - ids, of any kind. Every foreign key still resolves and every url still works.
//   - money. Prices, the ledger, payouts, splits — untouched, so the totals we test against
//     stay meaningful and a scrubbed database still reconciles.
//   - providers. They are the staff, they have accounts and passwords, and their names appear
//     on client-facing pages we need to look at. Scrambling them makes the app unreadable.
//   - Stripe ids. A scrubbed customer id would break the payment paths this environment exists
//     to test, and those ids identify nobody on their own.
//
//     Provider CONNECT ids are a separate matter and are not handled here: they arrive from the
//     v1 export as LIVE accounts, which a test key cannot see at all, so every payment in this
//     environment fails until they are replaced. That is
//     `scripts/dev-connect-accounts.ts`, and it needs running after every import too.

export interface Table {
  label: string
  /** Idempotent by construction: every expression derives from the row's own id, so running it
   *  twice produces the same result and never re-scrambles already-scrubbed data. */
  sql: string
  count: string
}

export const TABLES: Table[] = [
  {
    label: 'clients',
    count: `SELECT count(*)::int AS n FROM clients WHERE name NOT LIKE 'Client %'`,
    sql: `
      UPDATE clients SET
        name  = 'Client ' || upper(left(replace(id::text, '-', ''), 6)),
        email = CASE WHEN email IS NULL THEN NULL
                     ELSE 'client.' || left(replace(id::text, '-', ''), 8) || '@example.com' END,
        phone = CASE WHEN phone IS NULL THEN NULL
                     ELSE '208-555-' || lpad((abs(hashtext(id::text)) % 10000)::text, 4, '0') END
      WHERE name NOT LIKE 'Client %'`,
  },
  {
    label: 'bookings',
    // Names are denormalised onto the booking, so scrubbing `clients` alone leaves the real
    // name sitting on the appointment — which is what the calendar actually renders.
    count: `SELECT count(*)::int AS n FROM bookings WHERE client_name NOT LIKE 'Client %'`,
    sql: `
      UPDATE bookings b SET
        client_name  = COALESCE(c.name, 'Client ' || upper(left(replace(b.id::text, '-', ''), 6))),
        client_email = c.email,
        client_phone = c.phone,
        notes        = CASE WHEN b.notes IS NULL THEN NULL ELSE 'Notes removed for development' END
      FROM clients c
      WHERE c.id = b.client_id AND b.client_name NOT LIKE 'Client %'`,
  },
  {
    label: 'bookings without a client record',
    count: `SELECT count(*)::int AS n FROM bookings WHERE client_id IS NULL AND client_name NOT LIKE 'Client %'`,
    sql: `
      UPDATE bookings SET
        client_name  = 'Client ' || upper(left(replace(id::text, '-', ''), 6)),
        client_email = CASE WHEN client_email IS NULL THEN NULL
                            ELSE 'client.' || left(replace(id::text, '-', ''), 8) || '@example.com' END,
        client_phone = CASE WHEN client_phone IS NULL THEN NULL ELSE '208-555-0000' END,
        notes        = CASE WHEN notes IS NULL THEN NULL ELSE 'Notes removed for development' END
      WHERE client_id IS NULL AND client_name NOT LIKE 'Client %'`,
  },
  {
    label: 'training enrolments',
    // Students are members of the public who paid for a course. Same duty of care.
    count: `SELECT count(*)::int AS n FROM training_enrollments WHERE last_name <> 'Student'`,
    sql: `
      UPDATE training_enrollments SET
        first_name     = 'Trainee',
        last_name      = 'Student',
        email          = 'trainee.' || left(replace(id::text, '-', ''), 8) || '@example.com',
        phone          = CASE WHEN phone IS NULL THEN NULL ELSE '208-555-0100' END,
        license_number = CASE WHEN license_number IS NULL THEN NULL ELSE 'RN-DEV-0000' END
      WHERE last_name <> 'Student'`,
  },
]

/** The scrub as plain SQL, for a caller that needs it inside its own transaction. */
export function scrubSql(): string {
  return TABLES.map((t) => `-- ${t.label}\n${t.sql.trim()};`).join('\n\n')
}
