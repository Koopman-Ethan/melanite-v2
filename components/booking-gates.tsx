import Link from 'next/link'

import type { BlockedGate } from '@/lib/auth/dal'

/** The booking gates a provider is failing, all of them at once.
 *
 *  Shared by the dashboard and the book page so the two can never describe the same state
 *  differently — in v1 the dashboard, the book page and the create endpoint each phrased these
 *  in their own words.
 */
export function BookingGates({ gates, heading }: { gates: BlockedGate[]; heading: string }) {
  if (gates.length === 0) return null

  return (
    <section className="rounded-card border border-warning/40 bg-warning/10 p-5">
      <h2 className="text-sm font-medium text-warning">{heading}</h2>

      {gates.length > 1 && (
        <p className="mt-1 text-xs text-ink-muted">
          {gates.length} things need sorting before you can book.
        </p>
      )}

      <ul className={gates.length > 1 ? 'mt-3 space-y-3' : 'mt-2'}>
        {gates.map((gate) => (
          <li key={gate.gate} className="flex gap-2.5 text-sm">
            {gates.length > 1 && (
              <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-warning" />
            )}
            <span className="min-w-0">
              <span className="text-ink-secondary">{gate.message}</span>
              {gate.href && gate.action && (
                <Link
                  href={gate.href}
                  className="ml-1.5 whitespace-nowrap text-gold underline underline-offset-4"
                >
                  {gate.action} →
                </Link>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
