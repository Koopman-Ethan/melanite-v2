import 'server-only'

import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'

import { db } from '@/lib/db'
import {
  clientPackageItems,
  clientPackages,
  clients,
  packageCheckoutLinks,
  packageRedemptions,
  packageTemplateItems,
  packageTemplates,
  providerServices,
  services,
} from '@/lib/db/schema'

// Packages: what a provider sells, and what each client has left.
//
// The rule that governs the whole feature, from v1's create-from-package header:
// "REDEMPTIONS MOVE NO MONEY — the split settled at purchase." A redemption is an
// entitlement being consumed, not a transaction. Nothing here touches the ledger.

export interface TemplateLine {
  serviceId: string
  serviceName: string
  quantity: number
  perSessionValue: string
}

export interface PackageTemplate {
  id: string
  name: string
  description: string | null
  totalPrice: string
  expiresAfterDays: number | null
  active: boolean
  createdAt: Date
  lines: TemplateLine[]
  /** Templates are soft-deleted, never removed, because sold packages point at them. */
  soldCount: number
}

export async function getPackageTemplates(providerId: string): Promise<PackageTemplate[]> {
  const templates = await db
    .select({
      id: packageTemplates.id,
      name: packageTemplates.name,
      description: packageTemplates.description,
      totalPrice: packageTemplates.totalPrice,
      expiresAfterDays: packageTemplates.expiresAfterDays,
      active: packageTemplates.active,
      createdAt: packageTemplates.createdAt,
      // Columns written out rather than interpolated, and it matters.
      //
      // Inside a `sql` fragment in a SELECT projection, drizzle renders a column as a bare
      // name — `${packageTemplates.id}` becomes `"id"`, not `"package_templates"."id"`. In a
      // correlated subquery the inner table then wins the name, so this read
      // `where client_packages.package_template_id = client_packages.id`: a comparison between
      // two unrelated ids that is never true. It returned 0 for every template, so a package
      // that had sold still said "Not sold yet".
      //
      // The same fragment inside `.where()` IS qualified, which is why this survived review —
      // the identical pattern is correct three files away.
      soldCount: sql<number>`(
        select count(*) from ${clientPackages}
        where ${clientPackages}.package_template_id = ${packageTemplates}.id
      )::int`,
    })
    .from(packageTemplates)
    .where(eq(packageTemplates.providerId, providerId))
    .orderBy(desc(packageTemplates.active), asc(packageTemplates.name))

  if (templates.length === 0) return []

  const lines = await db
    .select({
      templateId: packageTemplateItems.packageTemplateId,
      serviceId: packageTemplateItems.serviceId,
      serviceName: services.name,
      quantity: packageTemplateItems.quantity,
      perSessionValue: packageTemplateItems.perSessionValue,
    })
    .from(packageTemplateItems)
    .innerJoin(services, eq(packageTemplateItems.serviceId, services.id))
    .where(
      inArray(
        packageTemplateItems.packageTemplateId,
        templates.map((t) => t.id),
      ),
    )
    .orderBy(asc(services.name))

  const byTemplate = new Map<string, TemplateLine[]>()
  for (const l of lines) {
    const list = byTemplate.get(l.templateId) ?? []
    list.push(l)
    byTemplate.set(l.templateId, list)
  }

  return templates.map((t) => ({ ...t, lines: byTemplate.get(t.id) ?? [] }))
}

export interface ClientPackageBalance {
  id: string
  clientId: string
  clientName: string | null
  clientEmail: string | null
  templateName: string
  status: (typeof clientPackages.status.enumValues)[number]
  purchasedAt: Date | null
  expiresAt: Date | null
  /** True once the expiry date has passed but the status still says active.
   *
   *  v1 flipped this "just in time" inside create-from-package — the row only became expired
   *  when someone tried to redeem it. So a list could show a package as active when it was
   *  not. Computing it on read means the display is honest without a write. */
  expiredByDate: boolean
  sessionsTotal: number
  sessionsUsed: number
  sessionsRemaining: number
  remainingValue: string
  lines: Array<{
    itemId: string
    serviceId: string
    serviceName: string
    qtyTotal: number
    qtyUsed: number
    perSessionValue: string
  }>
}

export async function getClientPackages(
  providerId: string,
  opts: { activeOnly?: boolean } = {},
): Promise<ClientPackageBalance[]> {
  const where = [eq(clientPackages.providerId, providerId)]
  if (opts.activeOnly) where.push(eq(clientPackages.status, 'active'))

  const packages = await db
    .select({
      id: clientPackages.id,
      clientId: clientPackages.clientId,
      clientName: clients.name,
      clientEmail: clients.email,
      templateName: packageTemplates.name,
      status: clientPackages.status,
      purchasedAt: clientPackages.purchasedAt,
      expiresAt: clientPackages.expiresAt,
    })
    .from(clientPackages)
    .innerJoin(clients, eq(clientPackages.clientId, clients.id))
    .innerJoin(packageTemplates, eq(clientPackages.packageTemplateId, packageTemplates.id))
    .where(and(...where))
    .orderBy(desc(clientPackages.purchasedAt))

  if (packages.length === 0) return []

  const items = await db
    .select({
      itemId: clientPackageItems.id,
      clientPackageId: clientPackageItems.clientPackageId,
      serviceId: clientPackageItems.serviceId,
      serviceName: services.name,
      qtyTotal: clientPackageItems.qtyTotal,
      qtyUsed: clientPackageItems.qtyUsed,
      perSessionValue: clientPackageItems.perSessionValue,
    })
    .from(clientPackageItems)
    .innerJoin(services, eq(clientPackageItems.serviceId, services.id))
    .where(
      inArray(
        clientPackageItems.clientPackageId,
        packages.map((p) => p.id),
      ),
    )
    .orderBy(asc(services.name))

  const now = new Date()

  return packages.map((p) => {
    const lines = items.filter((i) => i.clientPackageId === p.id)
    const sessionsTotal = lines.reduce((s, l) => s + l.qtyTotal, 0)
    const sessionsUsed = lines.reduce((s, l) => s + l.qtyUsed, 0)
    const remainingValue = lines
      .reduce((s, l) => s + (l.qtyTotal - l.qtyUsed) * Number(l.perSessionValue), 0)
      .toFixed(2)

    return {
      ...p,
      expiredByDate: Boolean(p.expiresAt && p.expiresAt < now && p.status === 'active'),
      sessionsTotal,
      sessionsUsed,
      sessionsRemaining: sessionsTotal - sessionsUsed,
      remainingValue,
      lines,
    }
  })
}

/** The redemption history for one package — "Session 3 of 6 · Laser 2 of 3" in v1's words.
 *  Voided rows are kept for audit but carry no index. */
export async function getRedemptionHistory(clientPackageId: string) {
  return db
    .select({
      id: packageRedemptions.id,
      bookingId: packageRedemptions.bookingId,
      overallIndex: packageRedemptions.overallIndex,
      serviceIndex: packageRedemptions.serviceIndex,
      redeemedAt: packageRedemptions.redeemedAt,
      voidedAt: packageRedemptions.voidedAt,
      serviceName: services.name,
    })
    .from(packageRedemptions)
    .innerJoin(
      clientPackageItems,
      eq(packageRedemptions.clientPackageItemId, clientPackageItems.id),
    )
    .innerJoin(services, eq(clientPackageItems.serviceId, services.id))
    .where(eq(packageRedemptions.clientPackageId, clientPackageId))
    .orderBy(asc(packageRedemptions.redeemedAt))
}

export interface OutstandingPackageLink {
  id: string
  clientName: string | null
  clientEmail: string | null
  templateName: string
  price: string
  createdAt: Date
  expiresAt: Date
  expired: boolean
  /** When the client left for Cherry, if they did. */
  cherryStartedAt: Date | null
}

/** Package payment links sent and not yet paid.
 *
 *  A link the provider cannot see is a sale they have to remember. This is also the only place
 *  a Cherry hand-off is visible to the person who sold the package — Cherry pays Keoni, not the
 *  provider, so the provider's own Stripe account will never show it and nothing else here
 *  would ever mention it.
 */
export async function getOutstandingPackageLinks(
  providerId: string,
): Promise<OutstandingPackageLink[]> {
  const rows = await db
    .select({
      id: packageCheckoutLinks.id,
      clientName: packageCheckoutLinks.clientName,
      clientEmail: packageCheckoutLinks.clientEmail,
      templateName: packageTemplates.name,
      price: packageCheckoutLinks.price,
      createdAt: packageCheckoutLinks.createdAt,
      expiresAt: packageCheckoutLinks.expiresAt,
      cherryStartedAt: packageCheckoutLinks.cherryStartedAt,
    })
    .from(packageCheckoutLinks)
    .innerJoin(packageTemplates, eq(packageCheckoutLinks.packageTemplateId, packageTemplates.id))
    .where(
      and(
        eq(packageCheckoutLinks.providerId, providerId),
        eq(packageCheckoutLinks.status, 'pending'),
      ),
    )
    // A client mid-application through Cherry is the one worth acting on, so it sorts first.
    // NULLS LAST is not optional here: Postgres orders DESC as NULLS FIRST, which would put
    // every link nobody has touched above the ones that need chasing.
    .orderBy(
      sql`${packageCheckoutLinks.cherryStartedAt} desc nulls last`,
      desc(packageCheckoutLinks.createdAt),
    )

  const now = new Date()
  return rows.map((r) => ({ ...r, expired: r.expiresAt < now }))
}

/** Services the provider offers, for building a template. A line item must be something they
 *  currently offer — v1's SERVICE_NOT_OFFERED. */
export async function getPackageableServices(providerId: string) {
  return db
    .select({
      serviceId: services.id,
      name: services.name,
      price: providerServices.price,
      packageEligible: services.packageEligible,
    })
    .from(providerServices)
    .innerJoin(services, eq(providerServices.serviceId, services.id))
    .where(
      and(
        eq(providerServices.providerId, providerId),
        eq(providerServices.isActive, true),
        eq(services.active, true),
      ),
    )
    .orderBy(asc(services.name))
}

/** Live (non-voided) redemption count, used to compute the next session indices. */
export async function countLiveRedemptions(clientPackageId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(packageRedemptions)
    .where(
      and(
        eq(packageRedemptions.clientPackageId, clientPackageId),
        isNull(packageRedemptions.voidedAt),
      ),
    )

  return row?.n ?? 0
}
