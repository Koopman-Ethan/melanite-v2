import { cn } from '@/lib/cn'
import { ONBOARDING_STEPS } from '@/lib/onboarding'

/** Progress header above each step's form. */
export function StepHeader({ current }: { current: number }) {
  const step = ONBOARDING_STEPS.find((s) => s.n === current)!
  return (
    <>
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-gold">
          Step {current} of {ONBOARDING_STEPS.length}
        </span>
        <span className="text-xs text-ink-muted">{step.title}</span>
      </div>
      <div className="mt-2 h-0.5 w-full rounded bg-line" role="presentation">
        <div
          className="h-full rounded bg-gold transition-[width]"
          style={{ width: `${(current / ONBOARDING_STEPS.length) * 100}%` }}
        />
      </div>
    </>
  )
}

/** The persistent rail: where you are, and why this step is being asked for.
 *
 *  Not decoration. Someone handing over a licence number and bank details deserves to see what
 *  happens to them, on the screen where they hand them over. */
export function ProgressRail({
  current,
  heading,
  body,
  aside,
}: {
  current: number
  heading: React.ReactNode
  body: string
  aside?: { title: string; body: string }
}) {
  return (
    <aside className="space-y-6">
      <div>
        <p className="text-xs uppercase tracking-wide text-gold">Provider onboarding</p>
        <h2 className="mt-2 text-2xl font-semibold leading-tight">{heading}</h2>
        <p className="mt-3 text-sm text-ink-muted">{body}</p>
      </div>

      <ol className="space-y-2">
        {ONBOARDING_STEPS.map((step) => {
          const done = step.n < current
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
                {done ? '✓' : step.n}
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
  rail,
  children,
}: {
  current: number
  rail: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="mx-auto grid w-full max-w-5xl gap-10 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="w-full max-w-md">
        <StepHeader current={current} />
        {children}
      </div>
      {rail}
    </div>
  )
}
