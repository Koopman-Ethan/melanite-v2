'use server'

import { randomBytes } from 'node:crypto'

import { and, eq, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

import {
  validateTemplate,
  type TemplateLineInput,
} from '@/lib/validate/package-template'

import { canBook, bookingBlockedReasons, requireProvider } from '@/lib/auth/dal'
import { db } from '@/lib/db'
import { isExclusionViolation } from '@/lib/db/errors'
import { denverInstant, getAvailability, getLaserHours, overlapsTrainingCourse } from '@/lib/db/queries/availability'
import {
  clientPackageItems,
  clientPackages,
  packageCheckoutLinks,
  packageRedemptions,
  packageTemplateItems,
  packageTemplates,
  providerServices,
  services,
} from '@/lib/db/schema'
import {
  appointmentWhen,
  bookingConfirmedEmail,
  packageLinkEmail,
  sendEmail,
} from '@/lib/email'
import { appOrigin } from '@/lib/stripe/config'

/** Package links live longer than booking links: a four-figure package is a decision, not a
 *  formality, and clients routinely think about it over a weekend. */
const PACKAGE_LINK_TTL_DAYS = 14

export interface PackageState {
  error?: string
  success?: string
}


async function offeredServiceIds(providerId: string): Promise<Set<string>> {
  const rows = await db
    .select({ serviceId: providerServices.serviceId })
    .from(providerServices)
    .innerJoin(services, eq(providerServices.serviceId, services.id))
    .where(
      and(
        eq(providerServices.providerId, providerId),
        eq(providerServices.isActive, true),
        eq(services.active, true),
      ),
    )

  return new Set(rows.map((r) => r.serviceId))
}

export async function createTemplate(input: {
  name: string
  description: string | null
  totalPrice: number
  expiresAfterDays: number | null
  lines: TemplateLineInput[]
}): Promise<PackageState> {
  const user = await requireProvider()

  const problem = validateTemplate(
    input.name,
    input.totalPrice,
    input.lines,
    await offeredServiceIds(user.id),
  )
  if (problem) return { error: problem }

  const [template] = await db
    .insert(packageTemplates)
    .values({
      providerId: user.id,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      totalPrice: input.totalPrice.toFixed(2),
      expiresAfterDays: input.expiresAfterDays,
      active: true,
    })
    .returning({ id: packageTemplates.id })

  await db.insert(packageTemplateItems).values(
    input.lines.map((l) => ({
      packageTemplateId: template.id,
      serviceId: l.serviceId,
      quantity: l.quantity,
      perSessionValue: l.perSessionValue.toFixed(2),
    })),
  )

  revalidatePath('/app/packages')
  return { success: `${input.name.trim()} created.` }
}

/** Editing replaces the line set wholesale, as v1 does.
 *
 *  Templates are only a blueprint — `client_package_items` are snapshotted at purchase, so
 *  editing one never rewrites a package someone already bought. That is what makes a full
 *  replace safe here.
 */
export async function updateTemplate(
  templateId: string,
  input: {
    name: string
    description: string | null
    totalPrice: number
    expiresAfterDays: number | null
    lines: TemplateLineInput[]
  },
): Promise<PackageState> {
  const user = await requireProvider()

  const [owned] = await db
    .select({ id: packageTemplates.id })
    .from(packageTemplates)
    .where(and(eq(packageTemplates.id, templateId), eq(packageTemplates.providerId, user.id)))
    .limit(1)

  if (!owned) return { error: 'That package is not yours.' }

  const problem = validateTemplate(
    input.name,
    input.totalPrice,
    input.lines,
    await offeredServiceIds(user.id),
  )
  if (problem) return { error: problem }

  await db
    .update(packageTemplates)
    .set({
      name: input.name.trim(),
      description: input.description?.trim() || null,
      totalPrice: input.totalPrice.toFixed(2),
      expiresAfterDays: input.expiresAfterDays,
    })
    .where(eq(packageTemplates.id, templateId))

  await db
    .delete(packageTemplateItems)
    .where(eq(packageTemplateItems.packageTemplateId, templateId))

  await db.insert(packageTemplateItems).values(
    input.lines.map((l) => ({
      packageTemplateId: templateId,
      serviceId: l.serviceId,
      quantity: l.quantity,
      perSessionValue: l.perSessionValue.toFixed(2),
    })),
  )

  revalidatePath('/app/packages')
  return { success: 'Package updated.' }
}

/** Soft delete, and its reverse. Never a hard delete — sold packages reference the template. */
export async function setTemplateActive(
  templateId: string,
  active: boolean,
): Promise<PackageState> {
  const user = await requireProvider()

  const result = await db
    .update(packageTemplates)
    .set({ active })
    .where(and(eq(packageTemplates.id, templateId), eq(packageTemplates.providerId, user.id)))
    .returning({ id: packageTemplates.id })

  if (result.length === 0) return { error: 'That package is not yours.' }

  revalidatePath('/app/packages')
  return { success: active ? 'Package reactivated.' : 'Package retired.' }
}

/** Open times for a redemption, on one date.
 *
 *  The booking page server-renders its slots from the URL, which suits a page whose whole job
 *  is picking a time. A redemption is chosen from a list of client balances, so it asks for
 *  times without navigating away — same availability query underneath, so the two can never
 *  disagree about what is free.
 *
 *  The laser is shared, so these openings account for every provider's bookings, not just
 *  this one's.
 */
export async function redemptionSlots(input: {
  providerServiceId: string
  date: string
}): Promise<{ error?: string; slots?: Array<{ startTime: string; label: string }> }> {
  const user = await requireProvider()

  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) return { error: 'Pick a date.' }

  const [svc] = await db
    .select({ durationMins: providerServices.durationMins })
    .from(providerServices)
    .where(
      and(
        eq(providerServices.id, input.providerServiceId),
        eq(providerServices.providerId, user.id),
        eq(providerServices.isActive, true),
      ),
    )
    .limit(1)

  if (!svc) return { error: 'That service is not on your profile.' }

  const { slots } = await getAvailability(input.date, svc.durationMins)

  return {
    slots: slots
      .filter((s) => s.available)
      .map((s) => ({
        startTime: s.startTime.toISOString(),
        label: s.startTime.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          timeZone: 'America/Denver',
        }),
      })),
  }
}

/** Book a prepaid session against a client's package balance.
 *
 *  v1's create-from-package, which is its most intricate endpoint. The rules kept verbatim:
 *
 *   - The same four booking gates as a paid booking. A redemption is still laser time.
 *   - NOT gated on the packages feature flag. v1's D2: "paid value must always be
 *     redeemable" — switching the feature off must never strand sessions a client bought.
 *   - The package must be the caller's, and must be active. Expiry is checked against the
 *     date, so a package past its expiry cannot be redeemed even if the status still says
 *     active.
 *   - The service must be a line on that package (SERVICE_NOT_IN_PACKAGE).
 *   - Global collision check against the shared laser, in the same statement as the insert.
 *   - The booking is $0 with original_price set to the per-session value, and gets NO
 *     checkout link — there is nothing to pay.
 *   - REDEMPTIONS MOVE NO MONEY. No ledger entry: the split settled at purchase.
 */
export async function bookFromPackage(input: {
  clientPackageId: string
  itemId: string
  providerServiceId: string
  startTime: string
  treatmentArea: string | null
  notes: string | null
}): Promise<PackageState> {
  const user = await requireProvider()

  if (!canBook(user)) {
    const gates = bookingBlockedReasons(user)
    return { error: gates.map((g) => g.message).join(' ') || 'Your account cannot book.' }
  }

  const [pkg] = await db
    .select({
      id: clientPackages.id,
      clientId: clientPackages.clientId,
      clientName: sql<string | null>`(select name from clients where id = ${clientPackages.clientId})`,
      clientEmail: sql<string | null>`(select email from clients where id = ${clientPackages.clientId})`,
      status: clientPackages.status,
      expiresAt: clientPackages.expiresAt,
    })
    .from(clientPackages)
    .where(
      and(eq(clientPackages.id, input.clientPackageId), eq(clientPackages.providerId, user.id)),
    )
    .limit(1)

  if (!pkg) return { error: 'That package does not exist.' }
  if (pkg.status === 'expired' || (pkg.expiresAt && pkg.expiresAt < new Date())) {
    return { error: 'This package has expired and can no longer be redeemed.' }
  }
  if (pkg.status !== 'active') {
    return { error: 'This package is not active — it may be used up or refunded.' }
  }

  // The chosen service must be a line on THIS package, and the provider must still offer it.
  const [line] = await db
    .select({
      itemId: clientPackageItems.id,
      qtyTotal: clientPackageItems.qtyTotal,
      qtyUsed: clientPackageItems.qtyUsed,
      perSessionValue: clientPackageItems.perSessionValue,
      serviceId: clientPackageItems.serviceId,
    })
    .from(clientPackageItems)
    .where(
      and(
        eq(clientPackageItems.id, input.itemId),
        eq(clientPackageItems.clientPackageId, input.clientPackageId),
      ),
    )
    .limit(1)

  if (!line) return { error: 'That service is not part of this package.' }
  // A cheap read for immediate feedback. It is NOT the guard — that happens atomically further
  // down, once everything else about the request has been validated.
  if (line.qtyUsed >= line.qtyTotal) {
    return { error: 'No sessions left for that service on this package.' }
  }

  const [svc] = await db
    .select({ durationMins: providerServices.durationMins, serviceId: providerServices.serviceId })
    .from(providerServices)
    .innerJoin(services, eq(providerServices.serviceId, services.id))
    .where(
      and(
        eq(providerServices.id, input.providerServiceId),
        eq(providerServices.providerId, user.id),
        eq(providerServices.isActive, true),
        eq(services.active, true),
      ),
    )
    .limit(1)

  if (!svc) return { error: 'That service is not available on your profile.' }
  if (svc.serviceId !== line.serviceId) {
    return { error: 'That service does not match the package line you picked.' }
  }

  const startTime = new Date(input.startTime)
  if (Number.isNaN(startTime.getTime())) return { error: 'That time is not valid.' }
  if (startTime <= new Date()) return { error: 'Choose a time in the future.' }

  const endTime = new Date(startTime.getTime() + svc.durationMins * 60_000)

  const hours = await getLaserHours()
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(startTime)
  if (
    startTime < denverInstant(day, hours.openTime) ||
    endTime > denverInstant(day, hours.closeTime)
  ) {
    return { error: 'That time is outside laser operating hours.' }
  }

  // Session indices, computed before the write. v1 does this inside the transaction; the
  // unique index on package_redemptions.booking_id is the real guard against a double insert,
  // and a stale index here would only mislabel a display string, not lose a session.
  const live = await db
    .select({
      overall: sql<number>`count(*)::int`,
      forService: sql<number>`count(*) filter (where ${packageRedemptions.clientPackageItemId} = ${input.itemId})::int`,
    })
    .from(packageRedemptions)
    .where(
      and(
        eq(packageRedemptions.clientPackageId, input.clientPackageId),
        sql`${packageRedemptions.voidedAt} is null`,
      ),
    )

  // The session is claimed HERE: after every validation, immediately before the write.
  //
  // Reading qty_used early and acting on it later is the shape of the training seat bug. The
  // increment used to sit after the booking and was clamped with least(), which kept the
  // COUNTER inside the total but did nothing about the bookings — two concurrent redemptions
  // of the last session both passed the check, both got an appointment, and the clamp swallowed
  // one increment. A free treatment, on a package that still looked like it had one left.
  //
  // Claiming this late matters as much as claiming atomically. Every `return { error }` above
  // is a path where nothing was booked, and a claim taken before them would cost a client a
  // session for mistyping a time.
  const claimed = await db
    .update(clientPackageItems)
    .set({ qtyUsed: sql`${clientPackageItems.qtyUsed} + 1` })
    .where(
      and(
        eq(clientPackageItems.id, input.itemId),
        sql`${clientPackageItems.qtyUsed} < ${clientPackageItems.qtyTotal}`,
      ),
    )
    .returning({ qtyUsed: clientPackageItems.qtyUsed })

  if (claimed.length === 0) {
    return { error: 'No sessions left for that service on this package.' }
  }

  /** Puts the claimed session back when the booking does not happen after all. */
  const releaseSession = () =>
    db
      .update(clientPackageItems)
      .set({ qtyUsed: sql`greatest(${clientPackageItems.qtyUsed} - 1, 0)` })
      .where(eq(clientPackageItems.id, input.itemId))

  const bookingId = crypto.randomUUID()

  // Collision check fused to the insert, exactly as in a paid booking — the laser does not
  // care that this session was prepaid.
  let booked
  try {
    booked = await db.execute(sql`
    INSERT INTO bookings
      (id, provider_id, provider_service_id, client_id, client_name, client_email,
       treatment_area, notes, original_price, price, payment_source,
       duration_mins, start_time, end_time, status)
    SELECT ${bookingId}::uuid, ${user.id}::uuid, ${input.providerServiceId}::uuid,
           ${pkg.clientId}::uuid, ${pkg.clientName ?? 'Client'}, ${pkg.clientEmail},
           ${input.treatmentArea}, ${input.notes},
           -- No discount columns: there was a discount_pct here and that has never existed on
           -- this table. The real columns are discount_type and discount_value, both
           -- defaulting to none. A redemption is not a discounted booking anyway; it is a
           -- session the client already owns, which is what original_price and a price of
           -- zero say between them.
           ${line.perSessionValue}::numeric, 0::numeric,
           'package_redemption'::booking_payment_source,
           ${svc.durationMins}, ${startTime.toISOString()}::timestamptz,
           ${endTime.toISOString()}::timestamptz, 'upcoming'::booking_status
    WHERE NOT EXISTS (
      SELECT 1 FROM bookings b
      WHERE b.status IN ('upcoming', 'completed')
        AND b.start_time < ${endTime.toISOString()}::timestamptz
        AND b.end_time   > ${startTime.toISOString()}::timestamptz
    )
    -- ...and not inside a training course. Same statement as the booking check on
    -- purpose: two separate reads could each pass against a different snapshot.
    AND NOT ${overlapsTrainingCourse(startTime.toISOString(), endTime.toISOString())}
    RETURNING id
  `)
  } catch (err) {
    // Same race as the ordinary booking path, now caught by `bookings_no_overlap`. The session
    // goes back — the client did not get a treatment out of a lost race.
    await releaseSession()
    if (isExclusionViolation(err)) {
      return { error: 'Someone just booked that slot. Pick another time.' }
    }
    throw err
  }

  if ((booked.rows?.length ?? 0) === 0) {
    // The slot went to someone else, so the session was never actually used.
    await releaseSession()
    return { error: 'Someone just booked that slot. Pick another time.' }
  }

  await db.insert(packageRedemptions).values({
    clientPackageId: input.clientPackageId,
    clientPackageItemId: input.itemId,
    bookingId,
    overallIndex: (live[0]?.overall ?? 0) + 1,
    serviceIndex: (live[0]?.forService ?? 0) + 1,
  })

  // Exhausted once every line is used up.
  const remaining = await db
    .select({ left: sql<number>`sum(${clientPackageItems.qtyTotal} - ${clientPackageItems.qtyUsed})::int` })
    .from(clientPackageItems)
    .where(eq(clientPackageItems.clientPackageId, input.clientPackageId))

  if ((remaining[0]?.left ?? 0) <= 0) {
    await db
      .update(clientPackages)
      .set({ status: 'exhausted' })
      .where(eq(clientPackages.id, input.clientPackageId))
  }

  // Nothing else in this flow says a word to the client. A paid booking at least sends them a
  // payment link they can look at; a redemption has no payment, no link and no receipt, so
  // without this they are told about their appointment by the provider or not at all.
  //
  // Best effort, after the session is claimed and the booking exists: a bounced email must not
  // undo a booking that has already happened.
  if (pkg.clientEmail) {
    try {
      const [svcName] = await db
        .select({ name: services.name })
        .from(providerServices)
        .innerJoin(services, eq(providerServices.serviceId, services.id))
        .where(eq(providerServices.id, input.providerServiceId))
        .limit(1)

      await sendEmail({
        to: pkg.clientEmail,
        ...bookingConfirmedEmail({
          clientName: pkg.clientName ?? 'there',
          providerName: `${user.firstName} ${user.lastName}`,
          serviceName: svcName?.name ?? 'Your appointment',
          when: appointmentWhen(startTime),
          // Null, not "$0.00": nothing was charged today, and a receipt-shaped zero invites
          // the question of what happened to their money.
          amount: null,
        }),
      })
    } catch (err) {
      console.error('[email] redemption confirmation failed', err)
    }
  }

  revalidatePath('/app/packages')
  revalidatePath('/app/appointments')
  return { success: 'Session booked from the package.' }
}

/** Creates a payment link for a package template.
 *
 *  The price is snapshotted onto the link rather than read from the template at pay time.
 *  Without that, editing a template between sending a link and the client paying silently
 *  changes what they are charged — they see one number in a text message and another at
 *  checkout, and nothing records that it moved.
 *
 *  Any existing pending link for this template and client is cancelled first, so a provider who
 *  clicks twice does not leave two live links quoting different prices.
 */
export async function createPackageLink(input: {
  templateId: string
  clientName: string | null
  clientEmail: string | null
  clientPhone: string | null
}): Promise<PackageState & { url?: string }> {
  const user = await requireProvider()

  const [template] = await db
    .select({
      id: packageTemplates.id,
      name: packageTemplates.name,
      totalPrice: packageTemplates.totalPrice,
      isActive: packageTemplates.active,
    })
    .from(packageTemplates)
    .where(and(eq(packageTemplates.id, input.templateId), eq(packageTemplates.providerId, user.id)))
    .limit(1)

  if (!template) return { error: 'That package does not exist.' }
  if (!template.isActive) return { error: 'That package is inactive. Reactivate it first.' }
  if (Number(template.totalPrice) <= 0) return { error: 'That package has no price set.' }

  const email = input.clientEmail?.trim().toLowerCase() || null

  await db
    .update(packageCheckoutLinks)
    .set({ status: 'cancelled' })
    .where(
      and(
        eq(packageCheckoutLinks.packageTemplateId, template.id),
        eq(packageCheckoutLinks.providerId, user.id),
        eq(packageCheckoutLinks.status, 'pending'),
        email ? eq(packageCheckoutLinks.clientEmail, email) : sql`false`,
      ),
    )

  const token = randomBytes(24).toString('base64url')

  const [link] = await db
    .insert(packageCheckoutLinks)
    .values({
      token,
      packageTemplateId: template.id,
      providerId: user.id,
      clientName: input.clientName?.trim() || null,
      clientEmail: email,
      clientPhone: input.clientPhone?.trim() || null,
      price: template.totalPrice,
      expiresAt: new Date(Date.now() + PACKAGE_LINK_TTL_DAYS * 24 * 60 * 60 * 1000),
    })
    .returning({ token: packageCheckoutLinks.token })

  const url = `${await appOrigin()}/pay/package/${link.token}`

  // A link nobody can deliver is not much of a link. Sending is best-effort: the provider still
  // gets the URL back to send by text, which is how most of these actually travel.
  let delivered = false
  if (email) {
    try {
      const [{ sessions }] = await db
        .select({ sessions: sql<number>`coalesce(sum(${packageTemplateItems.quantity}), 0)::int` })
        .from(packageTemplateItems)
        .where(eq(packageTemplateItems.packageTemplateId, template.id))

      const result = await sendEmail({
        to: email,
        ...packageLinkEmail({
          clientName: input.clientName?.trim() ?? null,
          providerName: `${user.firstName} ${user.lastName}`,
          packageName: template.name,
          sessions: Number(sessions),
          amount: `$${Number(template.totalPrice).toFixed(2)}`,
          url,
        }),
      })
      delivered = result.delivered
    } catch (err) {
      console.error('[email] package link failed', err)
    }
  }

  revalidatePath('/app/packages')

  return {
    success: delivered
      ? `Link created and emailed to ${email}.`
      : `Link created for ${template.name}. Copy it to your client.`,
    url,
  }
}
