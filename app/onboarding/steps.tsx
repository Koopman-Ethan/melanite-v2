import { cn } from '@/lib/cn'
import { ONBOARDING_STEPS, type PracticeType, stepsFor } from '@/lib/onboarding'

/** Where a step sits in the list THIS provider walks, which is not always its canonical number.
 *
 *  `onboardingStep` is canonical — 5 means the medical director step for everybody, which is
 *  what lets one column describe both kinds of provider. But a room renter never sees steps 4
 *  or 6, so showing them canonical numbers means "Step 5 of 6" on their final screen, a Connect
 *  step ticked off that they never did, and a services step promised that never arrives.
 *
 *  So the DATA stays canonical and the DISPLAY counts only what applies. */
function position(current: number, practice: PracticeType) {
  const steps = stepsFor(practice)
  const index = steps.findIndex((s) => s.n === current)
  return { steps, at: index === -1 ? 1 : index + 1, total: steps.length }
}

/** Progress header above each step's form. */
export function StepHeader({
  current,
  practice = 'laser',
}: {
  current: number
  practice?: PracticeType
}) {
  const step = ONBOARDING_STEPS.find((s) => s.n === current)!
  const { at, total } = position(current, practice)
  return (
    <>
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-gold">
          Step {at} of {total}
        </span>
        <span className="text-xs text-ink-muted">{step.title}</span>
      </div>
      <div className="mt-2 h-0.5 w-full rounded bg-line" role="presentation">
        <div
          className="h-full rounded bg-gold transition-[width]"
          style={{ width: `${(at / total) * 100}%` }}
        />
      </div>
    </>
  )
}

/** The persistent rail: where you are, and why this step is being asked for.
 *
 *  Not decoration. Someone handing over a license number and bank details deserves to see what
 *  happens to them, on the screen where they hand them over. */
export function ProgressRail({
  current,
  practice = 'laser',
  heading,
  body,
  aside,
}: {
  current: number
  practice?: PracticeType
  heading: React.ReactNode
  body: string
  aside?: { title: string; body: string }
}) {
  const { steps, at } = position(current, practice)
  return (
    <aside className="space-y-6">
      <div>
        <p className="text-xs uppercase tracking-wide text-gold">Provider onboarding</p>
        <h2 className="mt-2 text-2xl font-semibold leading-tight">{heading}</h2>
        <p className="mt-3 text-sm text-ink-muted">{body}</p>
      </div>

      <ol className="space-y-2">
        {steps.map((step, i) => {
          const done = i + 1 < at
          const active = step.n === current
          return (
            <li
              key={step.n}
              aria-current={active ? 'step' : undefined}
              className={cn(
                'flex items-center gap-3 rounded-card border p-3',
                active ? 'border-gold bg-gold/5' : 'border-line',
              )}
            >
              <span
                className={cn(
                  'flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-medium',
                  done
                    ? 'bg-overlay text-success'
                    : active
                      ? 'bg-gold text-gold-ink'
                      : 'bg-overlay text-ink-muted',
                )}
                aria-hidden
              >
                {done ? '✓' : i + 1}
              </span>
              <span className="min-w-0">
                <span className={cn('block text-sm', active ? 'text-ink' : 'text-ink-secondary')}>
                  {step.title}
                </span>
                {/* The state is in the text too, not only the tick's colour. */}
                <span className="block text-xs text-ink-faint">
                  {done ? 'Complete' : step.blurb}
                </span>
              </span>
            </li>
          )
        })}
      </ol>

      {aside && (
        <div className="rounded-card border border-line p-4">
          <p className="text-xs uppercase tracking-wide text-gold">{aside.title}</p>
          <p className="mt-2 text-xs leading-relaxed text-ink-muted">{aside.body}</p>
        </div>
      )}
    </aside>
  )
}

export function StepShell({
  current,
  practice = 'laser',
  rail,
  children,
}: {
  current: number
  practice?: PracticeType
  rail: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="mx-auto grid w-full max-w-5xl gap-10 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="w-full max-w-md">
        <StepHeader current={current} practice={practice} />
        {children}
      </div>
      {rail}
    </div>
  )
}
