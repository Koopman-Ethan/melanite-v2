import 'server-only'

import { randomUUID } from 'node:crypto'

import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm'

import type { SessionUser } from '@/lib/auth/session'
import { isAdmin } from '@/lib/auth/roles'
import {
  blobConfigured,
  contractAcceptable,
  deleteContract,
  headContract,
  newContractKey,
  parseContractKey,
} from '@/lib/blob'
import { db } from '@/lib/db'
import { providers, roomContracts, roomLeases } from '@/lib/db/schema'

import { CONTRACT_TYPES_SENTENCE } from './contract-file'

// Signed room contracts (migration 0050, 11 November 2026).
//
// Two people can put one on file: the tenant, on their Room Rental page, and Keoni for them, from
// Rooms. Either way it is the tenant's contract, and their page shows it whoever sent it.
//
// A contract WAITS until a lease uses it. Keoni starting a lease, or renewing one, takes the
// waiting contract and attaches it; from then it is the record that lease runs on and only the
// next renewal supersedes it. Uploading again while one is still waiting replaces it — the tenant
// who sent the unsigned copy by mistake should not leave it in the store.

type Actor = Pick<SessionUser, 'id' | 'role'>

/** The tenant themselves, or Keoni. Nobody else touches somebody's contract. */
export function mayHandleContractFor(actor: Actor, providerId: string): boolean {
  return isAdmin(actor.role) || actor.id === providerId
}

/** Where the browser should send a new contract for this tenant. The server names the file, so
 *  the environment prefix and the tenant's id in the path are never the browser's to choose. */
export async function contractUploadPath(
  actor: Actor,
  providerId: string,
  mimeType: string,
): Promise<{ pathname: string } | { error: string }> {
  if (!mayHandleContractFor(actor, providerId)) return { error: 'That is not your contract.' }
  if (!blobConfigured()) {
    return { error: 'File storage is not set up in this environment (BLOB_READ_WRITE_TOKEN).' }
  }

  const [tenant] = await db
    .select({ id: providers.id })
    .from(providers)
    .where(eq(providers.id, providerId))
    .limit(1)
  if (!tenant) return { error: 'That tenant does not exist.' }

  const pathname = newContractKey(providerId, randomUUID(), mimeType)
  if (!pathname) return { error: CONTRACT_TYPES_SENTENCE }
  return { pathname }
}

/**
 * Records a contract the browser says it has uploaded.
 *
 * CHECKED AGAINST THE STORE, not taken on trust: the row is written only if the file is really
 * there, is a type we accept and is within the size limit. The upload token already enforces all
 * three, so a failure here means somebody skipped the button — and what they sent is removed.
 *
 * Safe to call twice for the same file; the second call changes nothing.
 */
export async function recordContract(
  actor: Actor,
  storageKey: string,
): Promise<{ ok: true } | { error: string }> {
  const key = parseContractKey(storageKey)
  if (!key) return { error: 'That is not a contract upload.' }
  if (!mayHandleContractFor(actor, key.providerId)) return { error: 'That is not your contract.' }

  const landed = await headContract(storageKey)
  if (!landed) return { error: 'The file did not arrive. Try uploading it again.' }
  if (!contractAcceptable(landed)) {
    await deleteContract(storageKey)
    return { error: CONTRACT_TYPES_SENTENCE }
  }

  await db
    .insert(roomContracts)
    .values({
      id: key.contractId,
      providerId: key.providerId,
      uploadedBy: actor.id,
      storageKey,
      mimeType: landed.contentType,
      sizeBytes: landed.sizeBytes,
    })
    .onConflictDoNothing()

  // The one that was waiting before this is replaced, file and all. Contracts a lease already
  // runs on are not touched: `leaseId` is what makes one permanent.
  const replaced = await db
    .delete(roomContracts)
    .where(
      and(
        eq(roomContracts.providerId, key.providerId),
        isNull(roomContracts.leaseId),
        ne(roomContracts.id, key.contractId),
      ),
    )
    .returning({ storageKey: roomContracts.storageKey })
  for (const old of replaced) await deleteContract(old.storageKey)

  return { ok: true }
}

export interface ContractView {
  id: string
  uploadedAt: Date
  /** False when Keoni uploaded it for them. */
  byTenant: boolean
}

export interface ContractState {
  /** On file and not yet used: what lets Keoni start, or renew, a lease. */
  waiting: ContractView | null
  /** The one their running lease is on. */
  current: ContractView | null
}

/** Each tenant's contracts, for Keoni's Rooms page and for the tenant's own. */
export async function getContractStates(providerIds: string[]): Promise<Map<string, ContractState>> {
  const states = new Map<string, ContractState>(
    providerIds.map((id) => [id, { waiting: null, current: null }]),
  )
  if (providerIds.length === 0) return states

  const rows = await db
    .select({
      id: roomContracts.id,
      providerId: roomContracts.providerId,
      uploadedAt: roomContracts.uploadedAt,
      uploadedBy: roomContracts.uploadedBy,
      leaseId: roomContracts.leaseId,
      leaseStatus: roomLeases.status,
    })
    .from(roomContracts)
    .leftJoin(roomLeases, eq(roomLeases.id, roomContracts.leaseId))
    .where(inArray(roomContracts.providerId, providerIds))
    .orderBy(desc(roomContracts.uploadedAt))

  // Newest first, so the first of each kind seen is the one that counts.
  for (const row of rows) {
    const state = states.get(row.providerId)!
    const view = { id: row.id, uploadedAt: row.uploadedAt, byTenant: row.uploadedBy === row.providerId }
    if (!row.leaseId) state.waiting ??= view
    else if (row.leaseStatus && row.leaseStatus !== 'ended') state.current ??= view
  }
  return states
}

export async function getContractState(providerId: string): Promise<ContractState> {
  return (await getContractStates([providerId])).get(providerId)!
}

/** The waiting contract's id, which is what starting or renewing a lease consumes. */
export async function waitingContractId(providerId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: roomContracts.id })
    .from(roomContracts)
    .where(and(eq(roomContracts.providerId, providerId), isNull(roomContracts.leaseId)))
    .orderBy(desc(roomContracts.uploadedAt))
    .limit(1)
  return row?.id ?? null
}

/** Puts a waiting contract onto a lease. Conditional on it still waiting, so two presses cannot
 *  both use the same paper. */
export async function attachContract(contractId: string, leaseId: string): Promise<boolean> {
  const moved = await db
    .update(roomContracts)
    .set({ leaseId })
    .where(and(eq(roomContracts.id, contractId), isNull(roomContracts.leaseId)))
    .returning({ id: roomContracts.id })
  return moved.length > 0
}
