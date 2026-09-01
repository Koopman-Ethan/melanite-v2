import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getMembership } from '@/lib/db/queries/membership'
import { getRoster } from '@/lib/db/queries/providers-admin'

// The own-director path, which until now could display an arrangement but never create one.
//
// Every provider in production took the Melanite plan, where Stripe drives the gate and the
// membership page has a real button. The first provider to bring her own director found a page
// with nothing on it: no form, because `MembershipActions` returns null for `own`; no details,
// because that section only rendered when details already existed; and no way for anyone to add
// them, because `medical_director_credentials` had no writer anywhere in the application. The
// booking gate meanwhile linked her there saying "Set up your medical director".
//
// These tests pin the two rules that keep the fix honest: the details reach the people who need
// them, and filing them does not open a clinical gate.

const { neon } = await import('@neondatabase/serverless')
const sql = neon(process.env.DATABASE_URL!)

const EMAIL = `zz-director-${Date.now()}@example.com`
let providerId = ''

beforeAll(async () => {
  const rows = (await sql.query(
    `INSERT INTO providers (email, first_name, last_name, role, status,
                            medical_director_type, medical_director_status, booking_enabled)
     VALUES ($1, 'ZZ', 'Director', 'provider', 'active', 'own', 'none', false)
     RETURNING id`,
    [EMAIL],
  )) as { id: string }[]
  providerId = rows[0].id
})

afterAll(async () => {
  await sql.query(`DELETE FROM medical_director_credentials WHERE provider_id = $1`, [providerId])
  await sql.query(`DELETE FROM providers WHERE id = $1`, [providerId])
})

describe('a provider who brings her own medical director', () => {
  it('starts with nothing on file and no way to book', async () => {
    const membership = await getMembership(providerId)

    expect(membership.type).toBe('own')
    expect(membership.director).toBeNull()
    expect(membership.status).toBe('none')
  })

  it('shows the filed director once she has entered one', async () => {
    await sql.query(
      `INSERT INTO medical_director_credentials
         (provider_id, name, credentials, npi, license_number, license_state, contact_email)
       VALUES ($1, 'Dr ZZ Supervisor', 'MD', '1234567890', 'MD-999', 'Idaho', 'dr@example.com')`,
      [providerId],
    )

    const membership = await getMembership(providerId)
    expect(membership.director?.name).toBe('Dr ZZ Supervisor')
    expect(membership.director?.npi).toBe('1234567890')
  })

  it('does NOT open the booking gate just because details were filed', async () => {
    // The rule worth protecting. Deciding a supervision arrangement is real is a judgement about
    // a person's licence; if typing a name into a box cleared the gate, the gate would be
    // decorative and every provider could grant herself laser access.
    const membership = await getMembership(providerId)

    expect(
      membership.status,
      'filing director details activated the medical director gate on its own',
    ).toBe('none')

    const [row] = (await sql.query(
      `SELECT booking_enabled FROM providers WHERE id = $1`,
      [providerId],
    )) as { booking_enabled: boolean }[]
    expect(row.booking_enabled, 'filing director details opened booking on its own').toBe(false)
  })

  it('puts what she filed in front of Melanite on the roster', async () => {
    // Without this the submission goes into a void: she fills the form, and the person who has
    // to verify it has nowhere to read it.
    const { rows } = await getRoster()
    const mine = rows.find((r) => r.id === providerId)

    expect(mine, 'the provider vanished from the roster').toBeDefined()
    expect(mine?.director?.name).toBe('Dr ZZ Supervisor')
    expect(mine?.director?.licenseNumber).toBe('MD-999')
  })

  it('leaves everyone on the Melanite plan without a director object', async () => {
    // The join is LEFT for this reason — an inner one would have emptied the roster of every
    // provider who has ever existed here.
    const { rows } = await getRoster()
    const melanitePlan = rows.filter((r) => r.medicalDirectorType === 'melanite')

    expect(melanitePlan.length).toBeGreaterThan(0)
    expect(melanitePlan.every((r) => r.director === null)).toBe(true)
  })
})
