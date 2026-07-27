import { Brand } from '@/components/app-shell/brand'
import { requireProvider } from '@/lib/auth/dal'

/** Setup shell.
 *
 *  These routes live at `/onboarding/*`, a SIBLING of `/app`, and the location is the whole
 *  point. Nested under `/app` they inherited the signed-in app layout, so a provider halfway
 *  through setup got the full sidebar — Earnings, Packages, Book Laser Time, none of which they
 *  can use yet — a second Melanite logo above the first, and a clipped identity block. The
 *  comment here claimed they were outside the app shell; being one directory further out is
 *  what actually makes that true.
 *
 *  The "already finished, go away" guard lives on the individual steps rather than here: the
 *  final screen is reached AFTER status flips to active, so a layout-level guard would bounce
 *  a provider off their own completion page. */
export default async function OnboardingLayout({ children }: { children: React.ReactNode }) {
  await requireProvider()

  return (
    <div className="min-h-full">
      <header className="border-b border-line px-6 py-5">
        <div className="mx-auto w-full max-w-5xl">
          <Brand />
        </div>
      </header>
      <main className="px-6 py-10">{children}</main>
    </div>
  )
}
