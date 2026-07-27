'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { cn } from '@/lib/cn'
import { isActive, type NavItem } from '@/lib/nav'

/** Shared by the desktop sidebar and the mobile drawer, so the two can never drift — which is
 *  the failure mode v1 had with five duplicated sidebar variants. */
export function NavLinks({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  const pathname = usePathname()

  return (
    <nav className="flex flex-col gap-0.5 p-3">
      {items.map((item) => {
        const active = isActive(pathname, item.href)
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'rounded-field px-3 py-2.5 text-sm transition-colors',
              active
                ? 'bg-overlay text-gold'
                : 'text-ink-muted hover:bg-raised hover:text-ink-secondary',
            )}
          >
            {item.label}
          </Link>
        )
      })}
    </nav>
  )
}
