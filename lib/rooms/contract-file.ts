// What a signed contract may be, shared by the browser (to refuse early, in a sentence) and the
// server (which decides). No `server-only`: the upload button imports this.

/** A scan or a photo of signed paper. PDF is what a scanner app and an e-signature both produce. */
export const CONTRACT_MIME: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

/** Larger than the 3MB photos and receipts get, because a phone-scanned contract of several pages
 *  cannot be shrunk in the browser the way a photo can. It is affordable because a contract goes
 *  from the browser straight to the file store, not through a server action — see
 *  `app/api/room-contract/upload/route.ts`. */
export const CONTRACT_MAX_BYTES = 10 * 1024 * 1024

export const CONTRACT_TYPES_SENTENCE = 'A PDF or a photo — PDF, JPEG, PNG or WebP.'

export function contractTooBigMessage(sizeBytes: number): string {
  return `That file is ${(sizeBytes / 1024 / 1024).toFixed(1)}MB. The limit is ${CONTRACT_MAX_BYTES / 1024 / 1024}MB.`
}
