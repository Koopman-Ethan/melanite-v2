import { handleUpload, type HandleUploadBody } from '@vercel/blob/client'

import { getCurrentUser } from '@/lib/auth/dal'
import { blobConfigured, parseContractKey } from '@/lib/blob'
import { CONTRACT_MAX_BYTES, CONTRACT_MIME } from '@/lib/rooms/contract-file'
import { mayHandleContractFor } from '@/lib/rooms/contracts'

// Issues the short-lived token a browser needs to send ONE contract straight to the file store.
//
// Contracts skip the server action every other upload here uses, because a scanned contract can
// be larger than a server action will carry. The bytes never pass through this route — only the
// request for permission does — so the question it answers is whether THIS person may write THAT
// pathname. The pathname carries the tenant's id (the server chose it, in `contractUploadPath`),
// and the token is good for that pathname only, for these types, up to this size.
//
// Nothing is recorded here. The browser reports back through `recordContractAction` once the
// upload finishes, and that checks the store before writing a row. The store's own "upload
// completed" callback is not used: it cannot reach a laptop, and a flow that only works when
// deployed is one nobody can test.

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: Request): Promise<Response> {
  const user = await getCurrentUser()
  if (!user) return Response.json({ error: 'Sign in again, then retry.' }, { status: 401 })
  if (!blobConfigured()) {
    return Response.json({ error: 'File storage is not set up here.' }, { status: 503 })
  }

  let body: HandleUploadBody
  try {
    body = (await request.json()) as HandleUploadBody
  } catch {
    return Response.json({ error: 'Bad request.' }, { status: 400 })
  }
  // Only ever asked for a token. Anything else arriving here did not come from the upload button.
  if (body.type !== 'blob.generate-client-token') {
    return Response.json({ error: 'Bad request.' }, { status: 400 })
  }

  try {
    const result = await handleUpload({
      request,
      body,
      onBeforeGenerateToken: async (pathname) => {
        const key = parseContractKey(pathname)
        if (!key || !mayHandleContractFor(user, key.providerId)) {
          throw new Error('That is not your contract to upload.')
        }
        return {
          allowedContentTypes: Object.keys(CONTRACT_MIME),
          maximumSizeInBytes: CONTRACT_MAX_BYTES,
          // The pathname we record and the one it is saved under must be the same.
          addRandomSuffix: false,
        }
      },
    })
    return Response.json(result)
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'The upload could not be started.' },
      { status: 400 },
    )
  }
}
