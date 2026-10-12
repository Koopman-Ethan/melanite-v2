import { after } from 'next/server'

import { Brand } from '@/components/app-shell/brand'
import { Identity } from '@/components/app-shell/identity'
import { MobileNav } from '@/components/app-shell/mobile-nav'
import { NavLinks } from '@/components/app-shell/nav-links'
import { requireProvider } from '@/lib/auth/dal'
import { navFor } from '@/lib/nav'
import { maybeSettleRent } from '@/lib/rental/settle'

/** Shell for every /app/* route.
 *
 *  `requireProvider()` here is the authorization boundary for the whole section — proxy.ts
 *  only performs an optimistic cookie check and cannot be trusted for it. The call is
 *  React-cached, so a page below can call it again without a second query.
 *
 *  Note this guards authentication, not authorization: a page needing admin rights still
 *  calls requireAdmin() itself. A layout cannot protect its children in general, because
 *  Next may render a page without re-rendering the layout above it.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireProvider()
  const items = navFor(user)

  // Collect any rent that has come due, AFTER this response has gone out.
  //
  // Not for this provider and not about this page — it is a general sweep that happens to be
  // clocked by somebody opening the app. Vercel Cron is best effort and on the Hobby tier both
  // slots are already spent on the evening digest, so without a second clock a silently broken
  // schedule could stall billing for days with nothing to show it. Leased to once an hour, and
  // `maybeSettleRent` never throws.
  //
  // `after` rather than a bare un-awaited promise: work started during a render can otherwise be
  // cut off the moment the response finishes.
  after(maybeSettleRent)

  return (
    <div className="flex min-h-full flex-1 flex-col md:flex-row">
      <MobileNav items={items}>
        <Identity user={user} />
      </MobileNav>

      {/* 240px, #1a1a1a, matching v1's sidebar. */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-raised md:flex">
        <div className="border-b border-line px-5 py-6">
          <Brand />
        </div>
        <div className="flex-1 overflow-y-auto">
          <NavLinks items={items} />
        </div>
        <Identity user={user} />
      </aside>

      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
