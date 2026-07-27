import { logout } from '@/app/login/actions'
import type { SessionUser } from '@/lib/auth/session'

const ROLE_LABELS: Record<SessionUser['role'], string> = {
  platform_owner: 'Platform owner',
  developer: 'Developer',
  medical_director: 'Medical director',
  provider: 'Provider',
}

/** v1's sidebar identity block: name, role, and a sign-out. */
export function Identity({ user }: { user: SessionUser }) {
  const initials = `${user.firstName[0] ?? ''}${user.lastName[0] ?? ''}`.toUpperCase()

  return (
    <div className="border-t border-line p-3">
      <div className="flex items-center gap-3 px-1 py-2">
        <span
          aria-hidden
          className="grid size-8 shrink-0 place-items-center rounded-full bg-overlay text-[11px] font-bold text-gold"
        >
          {initials}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm text-ink-secondary">
            {user.firstName} {user.lastName}
          </span>
          <span className="block truncate text-xs text-ink-faint">{ROLE_LABELS[user.role]}</span>
        </span>
      </div>
      <form action={logout}>
        <button
          type="submit"
          className="w-full rounded-field px-3 py-2 text-left text-sm text-ink-muted transition-colors hover:bg-raised hover:text-ink-secondary"
        >
          Sign out
        </button>
      </form>
    </div>
  )
}
