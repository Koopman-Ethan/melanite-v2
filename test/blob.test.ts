import { afterEach, describe, expect, it, vi } from 'vitest'

import { blobConfigured, equipmentPhotoUrl, putEquipmentPhoto } from '@/lib/blob'

// What is allowed into the photo store, and — the part that matters — WHEN it is checked.
//
// v1's upload endpoint called `storage.create_attachment` and only then validated MIME and size,
// so every refused file had already been written. A 50MB upload was rejected and kept. These
// tests exist to pin the ordering as much as the rules: a refusal must reach the caller without
// anything being persisted.
//
// `put` is mocked because the alternative is writing to a real bucket from a unit test. That is
// also what makes the ordering assertion possible — if validation ever moves after the write,
// the spy sees a call it should never have received.

const put = vi.hoisted(() => vi.fn())
vi.mock('@vercel/blob', () => ({
  put,
  del: vi.fn(),
}))

/** The shape `putEquipmentPhoto` actually consumes — a real File is not needed. */
const file = (type: string, size: number) => ({
  type,
  size,
  arrayBuffer: async () => new ArrayBuffer(size),
})

const CHECK_ID = '3f6d1a30-b017-47b6-8553-0881639f8ce6'
const original = process.env.BLOB_READ_WRITE_TOKEN
const originalEnv = process.env.MELANITE_ENV

afterEach(() => {
  put.mockReset()
  if (original === undefined) delete process.env.BLOB_READ_WRITE_TOKEN
  else process.env.BLOB_READ_WRITE_TOKEN = original
  // Restored because one test below flips it to 'prod' to check the key prefix, and a leaked
  // 'prod' would make later suites believe they are running against production.
  if (originalEnv === undefined) delete process.env.MELANITE_ENV
  else process.env.MELANITE_ENV = originalEnv
})

function configured() {
  process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_test'
  put.mockResolvedValue({ pathname: `equipment/${CHECK_ID}.jpg` })
}

describe('what gets in', () => {
  it('accepts a downscaled phone photo', async () => {
    configured()
    const result = await putEquipmentPhoto(CHECK_ID, file('image/jpeg', 320_000))

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.blob.storageKey).toBe(`equipment/${CHECK_ID}.jpg`)
      expect(result.blob.sizeBytes).toBe(320_000)
    }
  })

  it('refuses anything that is not an image, WITHOUT writing it', async () => {
    // The ordering bug, pinned. A PDF renamed to .jpg still declares its type, and either way
    // nothing may reach the store before it has been judged.
    configured()
    const result = await putEquipmentPhoto(CHECK_ID, file('application/pdf', 1_000))

    expect(result.ok).toBe(false)
    expect(put, 'a refused file was written to storage anyway').not.toHaveBeenCalled()
  })

  it('refuses an oversized file WITHOUT writing it', async () => {
    // The expensive half of v1's bug: the bigger the file, the more it cost to reject it after
    // paying to store it.
    configured()
    const result = await putEquipmentPhoto(CHECK_ID, file('image/jpeg', 40 * 1024 * 1024))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('size')
    expect(put).not.toHaveBeenCalled()
  })

  it('refuses an empty file', async () => {
    configured()
    const result = await putEquipmentPhoto(CHECK_ID, file('image/jpeg', 0))
    expect(result.ok).toBe(false)
    expect(put).not.toHaveBeenCalled()
  })

  it('says so plainly when storage is not set up, rather than throwing', async () => {
    // Same contract as sendEmail. A provider standing in front of the laser should be told the
    // photo did not save, not shown a crash — and an unconfigured preview must not look broken.
    delete process.env.BLOB_READ_WRITE_TOKEN
    const result = await putEquipmentPhoto(CHECK_ID, file('image/jpeg', 1_000))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('not-configured')
    expect(put).not.toHaveBeenCalled()
    expect(blobConfigured()).toBe(false)
  })
})

describe('the key', () => {
  it('names the check and nothing about a person', async () => {
    // A storage key ends up in URLs, logs and error reports. None of those are places to put who
    // somebody was treating.
    configured()
    const result = await putEquipmentPhoto(CHECK_ID, file('image/png', 1_000))

    expect(result.ok).toBe(true)
    const [key, , options] = put.mock.calls[0]
    // Ends with the id and carries no name, email or booking reference. The environment prefix
    // is asserted separately — what matters here is what the key does NOT contain.
    expect(key).toContain(CHECK_ID)
    expect(key.endsWith(`${CHECK_ID}.png`)).toBe(true)
    // The key already carries a uuid, so a random suffix would mean the pathname recorded and the
    // pathname saved under diverge — and the photo becomes unreachable.
    expect(options.addRandomSuffix).toBe(false)
  })

  it('points at our own route, not the blob store', async () => {
    // The store is private, so a direct URL would 403 — and routing through the app is what lets
    // a read be authorised at all. It also means there is no public base URL to configure, and
    // so no failure mode where uploads succeed while every thumbnail silently breaks.
    expect(equipmentPhotoUrl(CHECK_ID)).toBe(`/api/equipment/photo/${CHECK_ID}`)
    expect(equipmentPhotoUrl(CHECK_ID)).not.toContain('blob.vercel-storage.com')
  })

  it('files dev uploads apart from real ones', async () => {
    // One store serves production and appdev. Without the prefix a test photo and a photograph
    // of the actual machine are indistinguishable uuids in the same bucket.
    configured()
    process.env.MELANITE_ENV = 'dev'
    await putEquipmentPhoto(CHECK_ID, file('image/jpeg', 1_000))
    expect(put.mock.calls[0][0]).toBe(`equipment/dev/${CHECK_ID}.jpg`)

    put.mockClear()
    process.env.MELANITE_ENV = 'prod'
    await putEquipmentPhoto(CHECK_ID, file('image/jpeg', 1_000))
    expect(put.mock.calls[0][0]).toBe(`equipment/${CHECK_ID}.jpg`)
  })
})
