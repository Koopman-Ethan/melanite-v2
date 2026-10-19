// Getting a file from somebody's phone to the server without it bouncing.
//
// SERVER ACTIONS HAVE A BODY LIMIT and exceeding it is not a nice error. Next rejects the whole
// request before any of our code runs, so every validation in `lib/blob.ts` is skipped and the
// provider gets a runtime overlay reading "Body exceeded 1 MB limit" — which tells them nothing
// they can act on and looks like the application broke.
//
// So the size is dealt with in the browser, twice over: images are redrawn smaller before they
// are ever sent, and anything still too large is refused with a sentence rather than a stack
// trace. The server's own check in `lib/blob.ts` stays as the backstop for a client that
// skipped both.
//
// Shared because the equipment photo and the client receipt hit the same wall. The photo flow
// had the downscaler first; the receipt was written without it and found the limit the hard
// way.

/** The long edge after shrinking. Comfortably enough to read a receipt or see a cracked
 *  handpiece, and about a tenth of what a modern phone camera produces. */
const MAX_EDGE = 1600

const QUALITY = 0.82

/** Types the blob store accepts as images. A file already small AND already one of these can
 *  skip the canvas entirely. */
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

/**
 * What a server action will carry, with headroom for the rest of the form.
 *
 * `next.config.ts` sets the action body limit to 4MB; this sits under it so a file that passes
 * here cannot be the thing that bursts it. The gap absorbs the field values, the boundary
 * overhead and the twenty-five checklist keys travelling alongside.
 */
export const MAX_UPLOAD_BYTES = 3 * 1024 * 1024

/** The sentence a provider sees. One they can act on, which "Body exceeded 1 MB limit" is not. */
export const TOO_BIG_MESSAGE = 'File chosen is too big. Please use a smaller file.'

export function isTooBig(file: { size: number }): boolean {
  return file.size > MAX_UPLOAD_BYTES
}

/**
 * Redraws an image smaller, in the browser, before it is ever sent.
 *
 * Returns the ORIGINAL file when anything goes wrong — a canvas that will not decode, an image
 * the browser dislikes. The server validates type and size regardless, so the worst case is a
 * slower upload rather than a lost file. Failing closed here would mean refusing to record a
 * laser somebody is standing in front of.
 *
 * NON-IMAGES PASS THROUGH UNTOUCHED. A PDF cannot be redrawn, which is why `isTooBig` exists
 * separately: a scanned receipt is the one upload here that can be large and cannot be shrunk,
 * and the only honest answer is to ask for a smaller one.
 */
export async function downscaleImage(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) return file

  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))

    // Small AND already a type the server takes. The second half matters: an iPhone hands back
    // HEIC from the photo library, which is often under a megabyte and which the server
    // refuses. Returning it untouched would turn a good photo into a type error. Redrawing it
    // through the canvas is what makes it a JPEG.
    if (scale === 1 && file.size < 1_000_000 && IMAGE_TYPES.has(file.type)) return file

    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)

    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', QUALITY),
    )
    if (!blob) return file

    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' })
  } catch {
    return file
  }
}

/**
 * Puts a file back into its input, so the form submits the one we processed rather than the one
 * the picker handed over.
 *
 * Wrapped because `DataTransfer` is the one API here a phone might not have, and failing it must
 * leave the ORIGINAL in the input — a slow upload beats a dead button.
 */
export function putBackInInput(input: HTMLInputElement | null, file: File): void {
  if (!input) return
  try {
    const box = new DataTransfer()
    box.items.add(file)
    input.files = box.files
  } catch {
    /* keep whatever the picker put there */
  }
}
