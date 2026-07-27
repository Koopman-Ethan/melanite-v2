import { Brand } from '@/components/app-shell/brand'

/** Shell for provider onboarding.
 *
 *  Two columns on a wide screen, matching v1: the form on the left, and on the right a
 *  persistent progress rail explaining why each step is being asked for. That rail is not
 *  decoration — a new provider handing over a licence number and bank details deserves to see
 *  what happens to them.
 */
export default function OnboardLayout({ children }: { children: React.ReactNode }) {
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
