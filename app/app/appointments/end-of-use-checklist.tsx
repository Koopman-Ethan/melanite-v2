'use client'

import { useActionState, useState } from 'react'

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
// Twenty-five ticks is a great deal more than the photograph asks for, and the same warning
// applies with more force: a provider who finds this slow will stop doing it honestly long before
// they stop doing it at all. So the sections collapse to a counter once touched, the whole thing
// opens behind one button, and a partial answer is a legitimate thing to submit rather than a
// failure state.
//
// NO "tick everything" control. It would make the form a single tap and the record worthless,
// which is the opposite of the trade this feature exists to make.

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
  laserPhotographed,
}: {
  bookingId: string
  /** The row, if this session was already closed out. Null means nobody has. */
  recorded: { itemsDone: number; itemCount: number; deviceIssue: boolean } | null
  /** Whether an arrival photograph exists. Stated back to them, never ticked FOR them. */
  laserPhotographed: boolean
}) {
  const [state, action, pending] = useActionState<ChecklistState, FormData>(
    recordEndOfUseChecklist,
    {},
  )
  const [open, setOpen] = useState(false)
  const [ticked, setTicked] = useState<string[]>([])
  const [collapsed, setCollapsed] = useState<string[]>([])
  const [issue, setIssue] = useState<'none' | 'reported' | ''>('')

  const done = new Set(ticked)
  const outstanding = missingRequired(ticked)
  const ready = outstanding.length === 0
  const requiredDone = REQUIRED_ITEM_COUNT - outstanding.length
  const shortageFlagged = done.has('supplies_notify_shortage')

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

            {/* A fact the app owns, stated where the photo item would otherwise be confused with
                it. Not a checkbox: letting somebody tick it would let them contradict the record. */}
            {section.key === 'docs' && !isCollapsed && (
              <p className="mt-2 text-[11px] text-ink-faint">
                {laserPhotographed
                  ? 'Laser photographed on arrival — we have that already.'
                  : 'No arrival photo for this session. That cannot be added now.'}
              </p>
            )}
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
        <Button type="submit" size="sm" disabled={pending || issue === '' || !ready}>
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

      <div className="border-t border-line pt-3">
        <p className="text-[11px] font-medium text-ink-secondary">
          Tell Melanite straight away — not here
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
