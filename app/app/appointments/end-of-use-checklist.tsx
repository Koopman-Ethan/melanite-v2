'use client'

import { useActionState, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Notice } from '@/components/ui/field'
import {
  DEVICE_ISSUE_NOTE_MAX,
  END_OF_USE_CERTIFICATION,
  END_OF_USE_ITEM_COUNT,
  END_OF_USE_SECTIONS,
  IMMEDIATE_REPORTING,
  REQUIRED_ITEM_COUNT,
  missingRequired,
} from '@/lib/end-of-use'

import { recordEndOfUseChecklist, type ChecklistState } from './end-of-use-actions'

// Closing out the suite, from a phone, with the next client possibly already waiting.
//
// Twenty-five items is a lot to ask of somebody in that position, and a provider who finds this
// slow will stop doing it honestly long before they stop doing it at all. So the sections collapse
// to a counter once touched and the whole thing opens behind one button.
//
// TWENTY OF THEM ARE REQUIRED. An earlier version let anybody submit having ticked nothing, on the
// theory that a truthful partial record beat a coerced full one; testing produced a signed
// certification with zero items behind it, which settled it. The five that stay optional describe
// things that may genuinely not have happened.
//
// NO "tick everything" control. It would make the form a single tap and the record worthless,
// which is the opposite of the trade this feature exists to make.

/** Longest edge after downscaling.
 *
 *  A phone photo is 3–5MB and a treatment room is the worst signal the app will ever see. At
 *  1600px a scratch, a warning light or a depleted consumable is perfectly legible.
 *
 *  Measured on a real iPhone photo through this path on 1 September: 1200x1600, and 671KB and
 *  714KB for the two checks. This comment previously guessed 200–400KB, which was optimistic by
 *  about half — worth stating as measurement rather than estimate, since the number is the whole
 *  argument for downscaling at all. Still roughly a fifth of the original, which is the
 *  difference between an upload that finishes while they put the phone down and one they
 *  cancel.
 *
 *  It also keeps the request inside the server action body limit, which a raw phone photo would
 *  blow straight through. */
const MAX_EDGE = 1600

/** What `lib/blob.ts` will actually take. Kept here only to decide whether a file can skip the
 *  canvas — the authoritative check is on the server. */
const SERVER_ACCEPTS = new Set(['image/jpeg', 'image/png', 'image/webp'])
const QUALITY = 0.82

/** Redraws the photo smaller, in the browser, before it is ever sent.
 *
 *  Returns the ORIGINAL file when anything goes wrong — a canvas that will not decode, an image
 *  the browser dislikes. The server validates type and size regardless, so the worst case is a
 *  slower upload rather than a lost photograph. Failing closed here would mean refusing to record
 *  a laser somebody is standing in front of. */
async function downscale(file: File): Promise<File> {
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
    // Small AND already a type the server takes. The second half matters: an iPhone hands back
    // HEIC from the photo library, which is often under a megabyte and which the server refuses.
    // Returning it untouched would turn a good photo into "Photos only — JPEG, PNG or WebP".
    // Redrawing it through the canvas is what makes it a JPEG.
    if (scale === 1 && file.size < 1_000_000 && SERVER_ACCEPTS.has(file.type)) return file

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

    return new File([blob], 'laser.jpg', { type: 'image/jpeg' })
  } catch {
    return file
  }
}

/** Native checkboxes, deliberately — not the `aria-pressed` pill buttons `room-form.tsx` uses.
 *  Four options can afford custom semantics; twenty-five cannot. A checkbox in a fieldset gives a
 *  screen reader the group, the position and the checked state for free. */
function Item({
  itemKey,
  label,
  hint,
  required,
  checked,
  onToggle,
}: {
  itemKey: string
  label: string
  hint?: string
  required: boolean
  checked: boolean
  onToggle: () => void
}) {
  return (
    <label className="flex min-h-11 cursor-pointer items-start gap-3 py-1.5">
      <input
        type="checkbox"
        name="items"
        value={itemKey}
        checked={checked}
        onChange={onToggle}
        // No top margin, and `leading-5` on the label below. `text-xs` gives a 16px line box
        // against a 20px checkbox, so their centres sat 4px apart and every single-line item read
        // as though its text floated above the box. Matching the line height to the control is
        // what actually centres them — nudging with a margin only moves the mismatch around, and
        // centring the whole block instead would drop the box to the middle of a three-line item.
        className="h-5 w-5 shrink-0 rounded border-line-control"
      />
      <span>
        <span className="block text-xs leading-5 text-ink-secondary">
          {label}
          {/* Only the OPTIONAL ones are marked. Twenty "required" badges would be wallpaper, and
              the useful signal is the short list of things you may legitimately leave. */}
          {!required && <span className="ml-1.5 text-[11px] text-ink-faint">If applicable</span>}
        </span>
        {hint && <span className="mt-0.5 block text-[11px] text-ink-faint">{hint}</span>}
      </span>
    </label>
  )
}

export function EndOfUseChecklist({
  bookingId,
  recorded,
}: {
  bookingId: string
  /** The row, if this session was already closed out. Null means nobody has. */
  recorded: { itemsDone: number; itemCount: number; deviceIssue: boolean } | null
}) {
  const [state, action, pending] = useActionState<ChecklistState, FormData>(
    recordEndOfUseChecklist,
    {},
  )
  const [open, setOpen] = useState(false)
  const [ticked, setTicked] = useState<string[]>([])
  const [collapsed, setCollapsed] = useState<string[]>([])
  const [issue, setIssue] = useState<'none' | 'reported' | ''>('')
  const [photoName, setPhotoName] = useState<string | null>(null)
  const photoRef = useRef<HTMLInputElement>(null)

  const done = new Set(ticked)
  const outstanding = missingRequired(ticked)
  const ready = outstanding.length === 0
  const requiredDone = REQUIRED_ITEM_COUNT - outstanding.length
  const shortageFlagged = done.has('supplies_notify_shortage')
  // A report needs its photograph. Enforced on the server and by the constraint too — this is the
  // courtesy that stops somebody filling the whole form in before being told.
  const photoMissing = issue === 'reported' && photoName === null

  // Shrinking happens on selection rather than on submit, so the wait overlaps with them typing
  // the description instead of following the button press.
  async function onPickPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setPhotoName(file.name)

    const smaller = await downscale(file)
    // Putting the shrunken file back into the input is what makes the form submit it. Wrapped
    // because DataTransfer is the one API here a phone might not have, and failing it must leave
    // the ORIGINAL photo in the input — a slow upload beats a dead button.
    try {
      const box = new DataTransfer()
      box.items.add(smaller)
      if (photoRef.current) photoRef.current.files = box.files
    } catch {
      /* keep whatever the picker put there */
    }
  }

  function toggle(key: string) {
    setTicked((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))
  }

  if (recorded && !state.success) {
    const full = recorded.itemsDone >= recorded.itemCount
    return (
      <div className="mt-3 text-xs">
        <p className={full ? 'text-success' : 'text-ink-muted'}>
          {full
            ? '✓ Closed out — everything ticked.'
            : `Closed out — ${recorded.itemsDone} of ${recorded.itemCount}.`}
        </p>
        {recorded.deviceIssue && (
          <p className="mt-1 text-critical">Device issue reported. Melanite has it.</p>
        )}
      </div>
    )
  }

  if (state.success) {
    return <p className="mt-3 text-xs text-success">{state.success}</p>
  }

  if (!open) {
    return (
      <div className="mt-3">
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          Close out the suite
        </Button>
        {/* Said here rather than inside, because somebody who reads this as an end-of-day form
            will file one a day and wonder why they are being chased. */}
        <p className="mt-1 text-[11px] text-ink-faint">
          Between clients too, not just at the end of the day.
        </p>
      </div>
    )
  }

  return (
    <form action={action} className="mt-3 space-y-4 rounded-card border border-line bg-overlay p-4">
      <input type="hidden" name="bookingId" value={bookingId} />

      <div>
        <p className="text-xs font-medium text-ink-secondary">How you left the suite</p>
        <p className="mt-1 text-[11px] text-ink-faint">
          Twenty of these apply to every session and are needed to sign off. Five are marked{' '}
          <em>If applicable</em> — leave those when they did not happen rather than ticking them
          anyway. Nothing here stops you working either way.
        </p>
      </div>

      {END_OF_USE_SECTIONS.map((section) => {
        const sectionRequired = section.items.filter((i) => i.required)
        const sectionDone = sectionRequired.filter((i) => done.has(i.key)).length
        const sectionShort = sectionDone < sectionRequired.length
        const isCollapsed = collapsed.includes(section.key)

        return (
          <fieldset key={section.key} className="border-t border-line pt-3">
            <legend className="sr-only">{section.title}</legend>
            <button
              type="button"
              onClick={() =>
                setCollapsed((prev) =>
                  prev.includes(section.key)
                    ? prev.filter((k) => k !== section.key)
                    : [...prev, section.key],
                )
              }
              className="flex min-h-11 w-full items-center justify-between text-left"
              aria-expanded={!isCollapsed}
            >
              <span className="text-xs font-medium text-ink-secondary">{section.title}</span>
              {/* Counts the REQUIRED items only. Counting all of them would show "5 of 7" for a
                  section that is actually finished, because two of its items did not apply. */}
              <span className={sectionShort ? 'text-[11px] text-warning' : 'text-[11px] text-success'}>
                {sectionDone} of {sectionRequired.length}
              </span>
            </button>

            {/* Hidden inputs keep a collapsed section's answers in the submission. Unmounting the
                checkboxes would silently drop what somebody already ticked. */}
            {isCollapsed
              ? section.items
                  .filter((i) => done.has(i.key))
                  .map((i) => <input key={i.key} type="hidden" name="items" value={i.key} />)
              : section.items.map((item) => (
                  <Item
                    key={item.key}
                    itemKey={item.key}
                    label={item.label}
                    hint={item.hint}
                    required={item.required}
                    checked={done.has(item.key)}
                    onToggle={() => toggle(item.key)}
                  />
                ))}

          </fieldset>
        )
      })}

      <fieldset className="border-t border-line pt-3">
        <legend className="text-xs font-medium text-ink-secondary">Device issues</legend>
        <label className="flex min-h-11 cursor-pointer items-center gap-3">
          <input
            type="radio"
            name="deviceIssue"
            value="none"
            checked={issue === 'none'}
            onChange={() => setIssue('none')}
            className="h-5 w-5"
          />
          <span className="text-xs text-ink-secondary">No device issues noted</span>
        </label>
        <label className="flex min-h-11 cursor-pointer items-center gap-3">
          <input
            type="radio"
            name="deviceIssue"
            value="reported"
            checked={issue === 'reported'}
            onChange={() => setIssue('reported')}
            className="h-5 w-5"
          />
          <span className="text-xs text-ink-secondary">Device issue reported</span>
        </label>

        {issue === 'reported' && (
          <div className="mt-2">
            <textarea
              name="deviceIssueNote"
              rows={3}
              maxLength={DEVICE_ISSUE_NOTE_MAX}
              required
              placeholder="What is wrong with it?"
              className="block w-full rounded-control border border-line-control bg-transparent p-2 text-xs"
            />
            {/* The one place a client's name is most likely to be typed into this app. Said at the
                point of typing, which is the only place a warning like this works. */}
            <p className="mt-1 text-[11px] text-ink-faint">
              About the equipment. No client names or clinical detail — anything about a person
              belongs in their chart.
            </p>
            <p className="mt-1 text-[11px] text-warning">
              If somebody was hurt, or the machine is unsafe, tell Melanite now rather than
              leaving it here.
            </p>

            <label
              htmlFor={`photo-${bookingId}`}
              className="mt-3 block text-xs font-medium text-ink-secondary"
            >
              Photo of the problem
            </label>
            <p className="mt-1 text-[11px] text-ink-faint">
              A picture of the machine, not of anyone. It is the only photograph of this we will
              have.
            </p>
            <input
              ref={photoRef}
              id={`photo-${bookingId}`}
              name="photo"
              type="file"
              // `image/*`, NOT the three types the server accepts. An explicit MIME list is the
              // difference between a control that opens and one that does nothing at all when
              // tapped: phones match `accept` against their own idea of a file's type, and an
              // entry they do not recognise can leave the picker with nothing it is willing to
              // offer. The server still enforces the real allowlist.
              //
              // NO `capture`. It looks like the right attribute and it fails CLOSED — it tells the
              // browser camera-or-nothing, so any browser that will not hand over the camera
              // offers no fallback and the control does nothing when tapped. Brave on iOS does
              // exactly that, which is what a provider testing on her own phone actually hit.
              accept="image/*"
              required
              onChange={onPickPhoto}
              className="mt-2 block w-full text-xs text-ink-muted file:mr-3 file:min-h-11 file:rounded-control file:border file:border-line-control file:bg-transparent file:px-3 file:text-xs file:font-bold file:text-ink-secondary"
            />
            {photoName && (
              <p className="mt-1 text-[11px] text-ink-faint">Ready to send: {photoName}</p>
            )}
          </div>
        )}
      </fieldset>

      <div className="border-t border-line pt-3">
        <label htmlFor={`note-${bookingId}`} className="block text-xs font-medium text-ink-secondary">
          Anything else?{' '}
          <span className="font-normal text-ink-faint">
            {shortageFlagged ? 'Say which supplies are short' : 'Optional'}
          </span>
        </label>
        {/* Ticking the shortage item IS the notification, so this is the only place the detail can
            go. Not enforced — a nudge at the point of typing, which is where it works. */}
        {shortageFlagged && (
          <p className="mt-1 text-[11px] text-warning">
            You flagged a supply shortage. Say which supplies below, or nobody can act on it.
          </p>
        )}
        <textarea
          id={`note-${bookingId}`}
          name="note"
          rows={2}
          maxLength={500}
          placeholder="A supply running low, anything odd."
          className="mt-1 block w-full rounded-control border border-line-control bg-transparent p-2 text-xs"
        />
      </div>

      {/* Names what is left rather than counting it. "3 still to tick" sends somebody scrolling
          back through five sections to work out which three. */}
      {outstanding.length > 0 && (
        <div className="rounded-card border border-warning/40 bg-warning/10 p-3">
          <p className="text-[11px] font-medium text-ink-secondary">
            Still to tick before you can sign off ({outstanding.length})
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] text-ink-secondary">
            {outstanding.slice(0, 4).map((i) => (
              <li key={i.key}>{i.label}</li>
            ))}
            {outstanding.length > 4 && <li>and {outstanding.length - 4} more</li>}
          </ul>
        </div>
      )}

      {/* One sentence, always. It is true for anything that can be submitted: the required twenty
          are done, and the five that are not ticked are the ones that did not apply. */}
      <p className="text-[11px] text-ink-muted">{END_OF_USE_CERTIFICATION}</p>

      {state.error && <Notice>{state.error}</Notice>}

      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={pending || issue === '' || !ready || photoMissing}>
          {pending
            ? 'Saving…'
            : ready
              ? ticked.length >= END_OF_USE_ITEM_COUNT
                ? 'Sign off — all 25'
                : `Sign off — ${ticked.length} of ${END_OF_USE_ITEM_COUNT}`
              : `${requiredDone} of ${REQUIRED_ITEM_COUNT} required`}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Not now
        </Button>
      </div>
      {issue === '' && ready && (
        <p className="text-[11px] text-ink-faint">Answer the device question to sign off.</p>
      )}
      {photoMissing && ready && (
        <p className="text-[11px] text-ink-faint">Add a photo of the problem to sign off.</p>
      )}

      <div className="border-t border-line pt-3">
        {/* This said "Tell Melanite straight away — NOT HERE", which stopped being true when
            reporting a device issue above started emailing her the same day. It was sending people
            away from the field built for exactly these. What survives is the part about people: a
            burn is not an equipment record and does not belong in this app at all. */}
        <p className="text-[11px] font-medium text-ink-secondary">Immediate reporting required</p>
        <p className="mt-1 text-[11px] text-ink-faint">
          Reporting a device issue above reaches Melanite the same day. Anything involving a
          person — a burn, a reaction — is a phone call, not a form.
        </p>
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] text-ink-faint">
          {IMMEDIATE_REPORTING.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
    </form>
  )
}
