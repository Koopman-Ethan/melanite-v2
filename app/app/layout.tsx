import { Brand } from '@/components/app-shell/brand'
import { Identity } from '@/components/app-shell/identity'
import { MobileNav } from '@/components/app-shell/mobile-nav'
import { NavLinks } from '@/components/app-shell/nav-links'
import { requireProvider } from '@/lib/auth/dal'
import { navFor } from '@/lib/nav'

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
