import { Brand } from '@/components/app-shell/brand'
import { requireProvider } from '@/lib/auth/dal'

/** Setup shell. Deliberately outside the app sidebar — a provider mid-setup has nothing to
 *  navigate to yet, and showing them Earnings before they can take a booking is noise.
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
