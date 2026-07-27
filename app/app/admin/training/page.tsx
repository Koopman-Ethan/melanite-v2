import type { Metadata } from 'next'
import Link from 'next/link'

import { requireAdmin } from '@/lib/auth/dal'
import { cn } from '@/lib/cn'
import { getCourses } from '@/lib/db/queries/training'

import { CourseForm } from './course-form'

export const metadata: Metadata = { title: 'Training · Melanite Admin' }
export const dynamic = 'force-dynamic'

const usd = (v: string) => Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

const dayLabel = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })

const STATUS_STYLES: Record<string, string> = {
  scheduled: 'border-info/40 bg-info/10 text-info',
  completed: 'border-success/40 bg-success/10 text-success',
  cancelled: 'border-line-strong bg-overlay text-ink-faint',
}

export default async function AdminTrainingPage() {
  await requireAdmin()
  const courses = await getCourses()

  const scheduled = courses.filter((c) => c.status === 'scheduled')
  const closed = courses.filter((c) => c.status !== 'scheduled')

  const totalCollected = courses.reduce((sum, c) => sum + Number(c.collected), 0)
  const totalOutstanding = scheduled.reduce((sum, c) => sum + Number(c.outstanding), 0)

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-10 space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Training</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Courses, enrolments and what students still owe.
        </p>
      </header>

      <section className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-card border border-line p-4">
          <div className="text-xs uppercase tracking-wide text-ink-muted">Collected</div>
          <div className="mt-1.5 text-2xl font-semibold tabular-nums">
            {usd(totalCollected.toFixed(2))}
          </div>
          <div className="mt-0.5 text-xs text-ink-faint">across every course</div>
        </div>
        <div className="rounded-card border border-line p-4">
          <div className="text-xs uppercase tracking-wide text-ink-muted">Outstanding</div>
          <div className="mt-1.5 text-2xl font-semibold tabular-nums">
            {usd(totalOutstanding.toFixed(2))}
          </div>
          <div className="mt-0.5 text-xs text-ink-faint">owed on scheduled courses</div>
        </div>
        <div className="rounded-card border border-line p-4">
          <div className="text-xs uppercase tracking-wide text-ink-muted">Upcoming</div>
          <div className="mt-1.5 text-2xl font-semibold tabular-nums">{scheduled.length}</div>
          <div className="mt-0.5 text-xs text-ink-faint">
            {scheduled.reduce((n, c) => n + c.enrolled, 0)} students enrolled
          </div>
        </div>
      </section>

      <CourseForm />

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">Scheduled</h2>
        {scheduled.length === 0 ? (
          <div className="rounded-card border border-dashed border-line p-8 text-center text-sm text-ink-muted">
            No courses scheduled.
          </div>
        ) : (
          <ul className="space-y-2">
            {scheduled.map((c) => (
              <CourseRow key={c.id} course={c} />
            ))}
          </ul>
        )}
      </section>

      {closed.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">
            Completed and cancelled
          </h2>
          <ul className="space-y-2">
            {closed.map((c) => (
              <CourseRow key={c.id} course={c} />
            ))}
          </ul>
        </section>
      )}

      {/* v1's training revenue never appeared in any admin total: the money lived in denormalized
          columns on the enrolment with no ledger row behind it. Stated here so the figures above
          are understood to be the same numbers the revenue page shows. */}
      <p className="text-xs text-ink-faint">
        These figures come from the same ledger as every other revenue stream — training is
        100% Melanite&rsquo;s, with no provider split.
      </p>
    </main>
  )
}

function CourseRow({ course }: { course: Awaited<ReturnType<typeof getCourses>>[number] }) {
  return (
    <li>
      <Link
        href={`/app/admin/training/${course.id}`}
        className="block rounded-card border border-line bg-surface p-4 transition-colors hover:border-line-strong"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{dayLabel(course.day1Date)}</span>
              {course.day2Date && (
                <span className="text-xs text-ink-muted">+ {dayLabel(course.day2Date)}</span>
              )}
              <span
                className={cn(
                  'rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide',
                  STATUS_STYLES[course.status] ?? 'border-line text-ink-muted',
                )}
              >
                {course.status}
              </span>
            </div>
            <p className="mt-1 text-xs text-ink-muted tabular-nums">
              {course.enrolled} of {course.maxStudents} seats · {usd(course.totalPrice)} each ·{' '}
              {usd(course.depositAmount)} deposit
            </p>
          </div>

          <div className="text-right">
            <div className="text-sm font-semibold tabular-nums">{usd(course.collected)}</div>
            {Number(course.outstanding) > 0 && (
              <div className="text-xs text-warning tabular-nums">
                {usd(course.outstanding)} owed
              </div>
            )}
          </div>
        </div>
      </Link>
    </li>
  )
}
