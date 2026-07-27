import type { Metadata } from 'next'

import { Brand } from '@/components/app-shell/brand'
import { getUpcomingCourses } from '@/lib/db/queries/training'

import { Enroll } from './enroll'

export const metadata: Metadata = {
  title: 'Laser training · Melanite',
  description: 'Hands-on laser certification with Melanite Laser Suite.',
}
export const dynamic = 'force-dynamic'

const todayInDenver = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date())

/** Public enrolment. Deliberately outside `/app/*` — a prospective student has no account, and
 *  training is how someone becomes a provider in the first place. */
export default async function TrainingPage() {
  const courses = await getUpcomingCourses(todayInDenver())

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-line px-6 py-5">
        <div className="mx-auto w-full max-w-lg">
          <Brand />
        </div>
      </header>
      <main className="flex-1 px-6 py-8">
        <Enroll courses={courses} />
      </main>
      <footer className="px-6 py-6 text-center text-xs text-ink-faint">
        Questions about training? Contact Melanite Laser Suite.
      </footer>
    </div>
  )
}
