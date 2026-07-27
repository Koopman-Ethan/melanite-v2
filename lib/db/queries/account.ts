import 'server-only'

import { desc, eq } from 'drizzle-orm'

import { db } from '@/lib/db'
import { documents, providers, sessions } from '@/lib/db/schema'

export interface AccountProfile {
  email: string
  firstName: string
  lastName: string
  phone: string | null
  credentials: string | null
  licenseNumber: string | null
  licenseState: string | null
  licenseExpiry: string | null
  malpracticeInsurance: string | null
  joinedAt: Date
  lastLoginAt: Date | null
  policyAckAt: Date | null
  policyAckVersion: string | null
  stripeOnboardingComplete: boolean
  notifyBookingConfirmed: boolean
  notifyPayoutDeposited: boolean
  notifyAppointmentReminders: boolean
  notifyNewAvailability: boolean
  notifyMembershipBilling: boolean
}

export async function getAccount(providerId: string): Promise<AccountProfile | null> {
  const [row] = await db
    .select({
      email: providers.email,
      firstName: providers.firstName,
      lastName: providers.lastName,
      phone: providers.phone,
      credentials: providers.credentials,
      licenseNumber: providers.licenseNumber,
      licenseState: providers.licenseState,
      licenseExpiry: providers.licenseExpiry,
      malpracticeInsurance: providers.malpracticeInsurance,
      joinedAt: providers.joinedAt,
      lastLoginAt: providers.lastLoginAt,
      policyAckAt: providers.policyAckAt,
      policyAckVersion: providers.policyAckVersion,
      stripeOnboardingComplete: providers.stripeOnboardingComplete,
      notifyBookingConfirmed: providers.notifyBookingConfirmed,
      notifyPayoutDeposited: providers.notifyPayoutDeposited,
      notifyAppointmentReminders: providers.notifyAppointmentReminders,
      notifyNewAvailability: providers.notifyNewAvailability,
      notifyMembershipBilling: providers.notifyMembershipBilling,
    })
    .from(providers)
    .where(eq(providers.id, providerId))
    .limit(1)

  return row ?? null
}

export interface AccountDocument {
  id: string
  docType: string
  originalFilename: string | null
  sizeBytes: number | null
  uploadedAt: Date
}

export async function getDocuments(providerId: string): Promise<AccountDocument[]> {
  return db
    .select({
      id: documents.id,
      docType: documents.docType,
      originalFilename: documents.originalFilename,
      sizeBytes: documents.sizeBytes,
      uploadedAt: documents.uploadedAt,
    })
    .from(documents)
    .where(eq(documents.providerId, providerId))
    .orderBy(desc(documents.uploadedAt))
}

export interface ActiveSession {
  id: string
  createdAt: Date
  lastUsedAt: Date
  userAgent: string | null
  ipAddress: string | null
}

/** Signed-in devices. New in v2 — a consequence of database-backed sessions, which v1 had no
 *  equivalent of, so there was no way to see or end a session from another device. */
export async function getActiveSessions(providerId: string): Promise<ActiveSession[]> {
  return db
    .select({
      id: sessions.id,
      createdAt: sessions.createdAt,
      lastUsedAt: sessions.lastUsedAt,
      userAgent: sessions.userAgent,
      ipAddress: sessions.ipAddress,
    })
    .from(sessions)
    .where(eq(sessions.providerId, providerId))
    .orderBy(desc(sessions.lastUsedAt))
}
