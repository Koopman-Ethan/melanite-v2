import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getCherryHandoffs } from '@/lib/db/queries/admin-tools'
import { getOutstandingPackageLinks } from '@/lib/db/queries/packages'

// Two signals Keoni had no way to see.
//
// A Groupon booking and a Groupon booking she has already collected on looked identical on the
// calendar — both just "paid outside the app". And a client who left for Cherry left no trace
// at all: the package link sat at `pending` forever, indistinguishable from one nobody opened,
// while the page told them to "tell your provider".
//
// Neither of these is payment. They are the difference between knowing what is outstanding and
// having to ask somebody.

const { neon } = await import('@neondatabase/serverless')
const sql = neon(process.env.DATABASE_URL!)

let providerId = ''
let providerServiceId = ''
let templateId = ''
const bookingIds: string[] = []
const linkIds: string[] = []

const at = (hour: number) => new Date(Date.UTC(2094, 4, 2, hour)).toISOString()

async function externalBooking(hour: number, method = 'groupon') {
  const rows = (await sql.query(
    `INSERT INTO bookings
       (provider_id, provider_service_id, client_name, original_price, price, payment_source,
        external_method, duration_mins, start_time, end_time, status)
     VALUES ($1, $2, 'ZZ Recon', '200.00', '200.00', 'external', $3::payment_method, 60,
             $4::timestamptz, $5::timestamptz, 'upcoming')
     RETURNING id`,
    [providerId, providerServiceId, method, at(hour), at(hour + 1)],
  )) as { id: string }[]
  bookingIds.push(rows[0].id)
  return rows[0].id
}

/** The exact expression the calendar uses, so this tests what ships. */
async function reconciled(bookingId: string): Promise<boolean> {
  const [row] = (await sql.query(
    `SELECT exists (
       SELECT 1 FROM ledger_entries l
        WHERE l.subject_type = 'booking' AND l.subject_id = $1 AND l.entry_type = 'purchase'
     ) AS reconciled`,
    [bookingId],
  )) as { reconciled: boolean }[]
  return row.reconciled
}

beforeAll(async () => {
  const svc = (await sql.query(
    `SELECT id, provider_id, service_id FROM provider_services WHERE is_active LIMIT 1`,
  )) as { id: string; provider_id: string; service_id: string }[]
  providerServiceId = svc[0].id
  providerId = svc[0].provider_id

  const tmpl = (await sql.query(
    `INSERT INTO package_templates (provider_id, name, total_price, active)
     VALUES ($1, 'ZZ Cherry Template', '600.00', false) RETURNING id`,
    [providerId],
  )) as { id: string }[]
  templateId = tmpl[0].id
})

afterAll(async () => {
  for (const id of bookingIds) {
    await sql.query(`DELETE FROM ledger_entries WHERE subject_id = $1`, [id])
    await sql.query(`DELETE FROM bookings WHERE id = $1`, [id])
  }
  for (const id of linkIds) await sql.query(`DELETE FROM package_checkout_links WHERE id = $1`, [id])
  if (templateId) await sql.query(`DELETE FROM package_templates WHERE id = $1`, [templateId])
})

describe('has this external booking been collected on?', () => {
  it('starts as not reconciled', async () => {
    const id = await externalBooking(1)
    expect(await reconciled(id)).toBe(false)
  })

  it('becomes reconciled once money is recorded against it', async () => {
    const id = await externalBooking(3)
    expect(await reconciled(id)).toBe(false)

    await sql.query(
      `INSERT INTO ledger_entries
         (source, payer, entry_type, subject_type, subject_id, provider_id, gross_amount,
          tip_amount, provider_payout, melanite_cut, payment_method, external_reference,
          payout_status)
       VALUES ('booking', 'client', 'purchase', 'booking', $1, $2, '200.00', '0.00', '100.00',
               '100.00', 'groupon', 'ZZ-VOUCHER', 'paid')`,
      [id, providerId],
    )

    expect(await reconciled(id)).toBe(true)
  })

  it('a refund does not make an unpaid booking look collected', async () => {
    // Only a `purchase` counts. Keying on "any ledger row" would mark a booking as settled the
    // moment a refund was recorded against it, which is the opposite of true.
    const id = await externalBooking(5)
    await sql.query(
      `INSERT INTO ledger_entries
         (source, payer, entry_type, subject_type, subject_id, provider_id, gross_amount,
          tip_amount, provider_payout, melanite_cut, payment_method, payout_status)
       VALUES ('booking', 'client', 'refund', 'booking', $1, $2, '-50.00', '0.00', '0.00',
               '-50.00', 'groupon', 'paid')`,
      [id, providerId],
    )
    expect(await reconciled(id)).toBe(false)
  })
})

describe('did the client go to Cherry?', () => {
  const makeLink = async (price: string) => {
    const rows = (await sql.query(
      `INSERT INTO package_checkout_links
         (token, package_template_id, provider_id, client_name, price, status, expires_at)
       VALUES ($1, $2, $3, 'ZZ Cherry Client', $4, 'pending', now() + interval '14 days')
       RETURNING id`,
      [`zzcherry${Date.now()}${linkIds.length}`, templateId, providerId, price],
    )) as { id: string }[]
    linkIds.push(rows[0].id)
    return rows[0].id
  }

  it('records the hand-off without claiming payment', async () => {
    const id = await makeLink('600.00')

    await sql.query(
      `UPDATE package_checkout_links SET cherry_started_at = now()
        WHERE id = $1 AND status = 'pending' AND cherry_started_at IS NULL`,
      [id],
    )

    const [row] = (await sql.query(
      `SELECT status, cherry_started_at FROM package_checkout_links WHERE id = $1`,
      [id],
    )) as Record<string, unknown>[]

    expect(row.cherry_started_at).not.toBeNull()
    // Still pending, and that is the point. They went to Cherry; nobody has said they paid.
    // Marking it paid because a link was clicked would be worse than no signal at all.
    expect(row.status).toBe('pending')
  })

  it('keeps the first hand-off time, not the latest click', async () => {
    const id = await makeLink('600.00')
    await sql.query(
      `UPDATE package_checkout_links SET cherry_started_at = now() - interval '2 hours'
        WHERE id = $1`,
      [id],
    )
    // ::text so the comparison is on the instant, not on two equal Date objects.
    const [before] = (await sql.query(
      `SELECT cherry_started_at::text FROM package_checkout_links WHERE id = $1`,
      [id],
    )) as Record<string, string>[]

    // The guard is `cherry_started_at IS NULL`, so a client returning to the page and clicking
    // again does not reset when they first went.
    await sql.query(
      `UPDATE package_checkout_links SET cherry_started_at = now()
        WHERE id = $1 AND status = 'pending' AND cherry_started_at IS NULL`,
      [id],
    )
    const [after] = (await sql.query(
      `SELECT cherry_started_at::text FROM package_checkout_links WHERE id = $1`,
      [id],
    )) as Record<string, string>[]

    expect(after.cherry_started_at).toBe(before.cherry_started_at)
  })

  it('does not record a hand-off on a link that is already paid', async () => {
    const id = await makeLink('600.00')
    await sql.query(`UPDATE package_checkout_links SET status = 'paid' WHERE id = $1`, [id])

    await sql.query(
      `UPDATE package_checkout_links SET cherry_started_at = now()
        WHERE id = $1 AND status = 'pending' AND cherry_started_at IS NULL`,
      [id],
    )

    const [row] = (await sql.query(
      `SELECT cherry_started_at FROM package_checkout_links WHERE id = $1`,
      [id],
    )) as Record<string, unknown>[]
    expect(row.cherry_started_at).toBeNull()
  })
})

// The half that was missing at first: the hand-off was recorded and shown nowhere. A signal
// only in the database is a signal nobody acts on, and Cherry is the one route where acting on
// it is the whole job — Cherry pays Melanite, and Melanite owes the provider half.

describe('who can see it', () => {
  const startCherry = async (id: string) =>
    sql.query(
      `UPDATE package_checkout_links SET cherry_started_at = now() - interval '3 days'
        WHERE id = $1`,
      [id],
    )

  const makeLink = async () => {
    const rows = (await sql.query(
      `INSERT INTO package_checkout_links
         (token, package_template_id, provider_id, client_name, price, status, expires_at)
       VALUES ($1, $2, $3, 'ZZ Cherry Visible', '600.00', 'pending', now() + interval '14 days')
       RETURNING id`,
      [`zzvis${Date.now()}${linkIds.length}`, templateId, providerId],
    )) as { id: string }[]
    linkIds.push(rows[0].id)
    return rows[0].id
  }

  it('reaches Keoni, with enough to act on', async () => {
    const id = await makeLink()
    await startCherry(id)

    const row = (await getCherryHandoffs()).find((c) => c.id === id)

    expect(row, 'a Cherry hand-off must reach the admin tools page').toBeDefined()
    expect(row!.price).toBe('600.00')
    expect(row!.packageName).toBe('ZZ Cherry Template')
    // She has to chase this with a person, so the provider's name is not decoration.
    expect(row!.providerName.trim().length).toBeGreaterThan(0)
    expect(row!.waitingDays).toBe(3)
  })

  it('leaves her list once the package is paid for', async () => {
    // By any route, including her recording it by hand. A queue that cannot empty is one people
    // learn to scroll past.
    const id = await makeLink()
    await startCherry(id)
    expect((await getCherryHandoffs()).some((c) => c.id === id)).toBe(true)

    await sql.query(`UPDATE package_checkout_links SET status = 'paid' WHERE id = $1`, [id])
    expect((await getCherryHandoffs()).some((c) => c.id === id)).toBe(false)
  })

  it('reaches the provider who sold it', async () => {
    // Cherry money never touches the provider's Stripe account, so without this the sale is
    // invisible to the one person the client is going to talk to about it.
    const id = await makeLink()
    await startCherry(id)

    const row = (await getOutstandingPackageLinks(providerId)).find((l) => l.id === id)
    expect(row, 'the provider must see their own outstanding link').toBeDefined()
    expect(row!.cherryStartedAt).not.toBeNull()
    expect(row!.expired).toBe(false)
  })

  it('shows an unpaid link that nobody took to Cherry, without implying they did', async () => {
    const id = await makeLink()
    const row = (await getOutstandingPackageLinks(providerId)).find((l) => l.id === id)
    expect(row).toBeDefined()
    expect(row!.cherryStartedAt).toBeNull()
    // And it is not on Keoni's Cherry list, because nothing has been applied for.
    expect((await getCherryHandoffs()).some((c) => c.id === id)).toBe(false)
  })

  it('marks a link whose 14 days ran out', async () => {
    const id = await makeLink()
    await sql.query(
      `UPDATE package_checkout_links SET expires_at = now() - interval '1 day' WHERE id = $1`,
      [id],
    )
    const row = (await getOutstandingPackageLinks(providerId)).find((l) => l.id === id)
    expect(row!.expired).toBe(true)
  })
})

describe('the provider sees the ones that need chasing first', () => {
  it('sorts Cherry applications above links nobody has touched', async () => {
    // Postgres orders DESC as NULLS FIRST. Without an explicit NULLS LAST this list leads with
    // every link that has had no activity at all — precisely the rows with nothing to do.
    const make = async (suffix: string) => {
      const rows = (await sql.query(
        `INSERT INTO package_checkout_links
           (token, package_template_id, provider_id, client_name, price, status, expires_at,
            created_at)
         VALUES ($1, $2, $3, 'ZZ Sort', '600.00', 'pending', now() + interval '14 days',
                 now() - interval '1 hour')
         RETURNING id`,
        [`zzsort${Date.now()}${suffix}`, templateId, providerId],
      )) as { id: string }[]
      linkIds.push(rows[0].id)
      return rows[0].id
    }

    // The untouched link is NEWER, so it wins on every tiebreak except the one that matters.
    const cherryId = await make('a')
    await sql.query(
      `UPDATE package_checkout_links
          SET cherry_started_at = now(), created_at = now() - interval '2 hours' WHERE id = $1`,
      [cherryId],
    )
    const quietId = await make('b')
    await sql.query(
      `UPDATE package_checkout_links SET created_at = now() WHERE id = $1`,
      [quietId],
    )

    const list = await getOutstandingPackageLinks(providerId)
    const cherryAt = list.findIndex((l) => l.id === cherryId)
    const quietAt = list.findIndex((l) => l.id === quietId)

    expect(cherryAt).toBeGreaterThanOrEqual(0)
    expect(quietAt).toBeGreaterThanOrEqual(0)
    expect(cherryAt, 'a Cherry application must outrank an untouched newer link').toBeLessThan(
      quietAt,
    )
  })
})
