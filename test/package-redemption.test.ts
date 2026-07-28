import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Package sessions, against a real database.
//
// A package is paid for up front and redeemed later, one session at a time. Redeeming more
// sessions than were bought is giving away treatments, and the counter that stops it was
// guarded the same way the training seat count was: read in one statement, acted on in
// another. The increment WAS clamped with least(qty_used + 1, qty_total), which kept the
// counter inside the total — and hid the problem, because two concurrent redemptions of the
// last session both created a booking and the clamp quietly discarded one increment.

const { neon } = await import('@neondatabase/serverless')
const sql = neon(process.env.DATABASE_URL!)

let itemId = ''
let packageId = ''
let templateId = ''
let clientId = ''
let providerId = ''
let serviceId = ''
const QTY = 3

/** The claim exactly as `bookFromPackage` issues it. */
async function claim(): Promise<boolean> {
  const rows = (await sql.query(
    `UPDATE client_package_items SET qty_used = qty_used + 1
      WHERE id = $1 AND qty_used < qty_total
      RETURNING qty_used`,
    [itemId],
  )) as unknown[]
  return rows.length > 0
}

async function used(): Promise<number> {
  const rows = (await sql.query(`SELECT qty_used FROM client_package_items WHERE id = $1`, [
    itemId,
  ])) as { qty_used: number }[]
  return Number(rows[0].qty_used)
}

beforeAll(async () => {
  const pick = (await sql.query(
    `SELECT ps.provider_id, ps.service_id FROM provider_services ps WHERE ps.is_active LIMIT 1`,
  )) as { provider_id: string; service_id: string }[]
  providerId = pick[0].provider_id
  serviceId = pick[0].service_id

  const client = (await sql.query(
    `INSERT INTO clients (name, email) VALUES ('ZZ Package Test', $1) RETURNING id`,
    [`zz.pkg.${Date.now()}@example.com`],
  )) as { id: string }[]
  clientId = client[0].id

  // A package instance points at the template it was sold from, so the template comes first.
  const template = (await sql.query(
    `INSERT INTO package_templates (provider_id, name, total_price, active)
     VALUES ($1, 'ZZ Test Package', '600.00', false) RETURNING id`,
    [providerId],
  )) as { id: string }[]
  templateId = template[0].id

  const pkg = (await sql.query(
    `INSERT INTO client_packages (provider_id, client_id, package_template_id, status, purchased_at)
     VALUES ($1, $2, $3, 'active', now()) RETURNING id`,
    [providerId, clientId, templateId],
  )) as { id: string }[]
  packageId = pkg[0].id

  const item = (await sql.query(
    `INSERT INTO client_package_items
       (client_package_id, service_id, qty_total, qty_used, per_session_value)
     VALUES ($1, $2, $3, 0, '200.00') RETURNING id`,
    [packageId, serviceId, QTY],
  )) as { id: string }[]
  itemId = item[0].id
})

afterAll(async () => {
  if (packageId) {
    await sql.query(`DELETE FROM client_package_items WHERE client_package_id = $1`, [packageId])
    await sql.query(`DELETE FROM client_packages WHERE id = $1`, [packageId])
  }
  if (templateId) await sql.query(`DELETE FROM package_templates WHERE id = $1`, [templateId])
  if (clientId) await sql.query(`DELETE FROM clients WHERE id = $1`, [clientId])
})

describe('redeeming sessions', () => {
  it('hands out exactly what was bought, under concurrency', async () => {
    // Ten simultaneous redemptions of a three-session package. Three succeed.
    const results = await Promise.all(Array.from({ length: 10 }, () => claim()))

    expect(results.filter(Boolean)).toHaveLength(QTY)
    expect(await used()).toBe(QTY)
  })

  it('refuses once the package is used up', async () => {
    expect(await claim()).toBe(false)
    expect(await used()).toBe(QTY)
  })

  it('gives the session back when the booking does not happen', async () => {
    // The slot being taken, or any failure after the claim, must not cost the client a
    // treatment they never received.
    await sql.query(
      `UPDATE client_package_items SET qty_used = greatest(qty_used - 1, 0) WHERE id = $1`,
      [itemId],
    )
    expect(await used()).toBe(QTY - 1)
    expect(await claim()).toBe(true)
    expect(await used()).toBe(QTY)
  })

  it('cannot be driven below zero', async () => {
    for (let i = 0; i < QTY + 2; i++) {
      await sql.query(
        `UPDATE client_package_items SET qty_used = greatest(qty_used - 1, 0) WHERE id = $1`,
        [itemId],
      )
    }
    expect(await used()).toBe(0)
  })

  it('would have oversold under the old clamped increment', async () => {
    // Demonstrates the bug rather than describing it. `least(qty_used + 1, qty_total)` accepts
    // every caller — nobody is ever told no — so the count stops at the total while each caller
    // believed it had a session and went on to create a booking.
    await sql.query(`UPDATE client_package_items SET qty_used = $2 WHERE id = $1`, [itemId, QTY])

    const oldWay = async () => {
      await sql.query(
        `UPDATE client_package_items
            SET qty_used = least(qty_used + 1, qty_total) WHERE id = $1`,
        [itemId],
      )
      return true // the old code had no way to know it had been refused
    }

    const results = await Promise.all([oldWay(), oldWay()])
    expect(results.every(Boolean)).toBe(true)
    expect(await used()).toBe(QTY) // clamped — and two bookings would exist against it

    await sql.query(`UPDATE client_package_items SET qty_used = 0 WHERE id = $1`, [itemId])
  })
})
