import { Brand } from '@/components/app-shell/brand'

/** Shell for the public checkout pages.
 *
 *  Deliberately separate from `/app/*`: there is no sidebar, no session, and nothing here may
 *  assume a signed-in provider. The only thing shared is the brand mark, which is the point —
 *  a client following a texted link should land somewhere recognisably Melanite.
 */
export default function PayLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-line px-6 py-5">
        <div className="mx-auto w-full max-w-lg">
          <Brand />
        </div>
      </header>

      <main className="flex-1 px-6 py-8">{children}</main>

      <footer className="px-6 py-6 text-center text-xs text-ink-faint">
        Questions about this payment? Contact your provider directly.
      </footer>
    </div>
  )
}
