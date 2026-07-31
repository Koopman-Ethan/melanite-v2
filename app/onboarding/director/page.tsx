import type { Metadata } from 'next'
import { eq } from 'drizzle-orm'

import { db } from '@/lib/db'
import { providers } from '@/lib/db/schema'

import { requireOnboardingStep } from '../guard'
import { ProgressRail, StepShell } from '../steps'
import { DirectorForm } from './form'
import { RoomProceduresForm } from './room-form'

export const metadata: Metadata = { title: 'Medical director · Melanite' }
export const dynamic = 'force-dynamic'

export default async function DirectorStep({
  searchParams,
}: {
  searchParams: Promise<{ subscribed?: string }>
}) {
  const user = await requireOnboardingStep('director')
  const { subscribed } = await searchParams

  const [row] = await db
    .select({
      type: providers.medicalDirectorType,
      status: providers.medicalDirectorStatus,
      practiceType: providers.practiceType,
      roomProcedures: providers.roomProcedures,
    })
    .from(providers)
    .where(eq(providers.id, user.id))
    .limit(1)

  // A room renter is asked a different question entirely: not whose director, but whether what
  // they perform needs one at all. The app decides from the answer.
  if (row?.practiceType === 'room_only') {
    return (
      <StepShell
        current={5}
        practice="room_only"
        rail={
          <ProgressRail
            current={5}
            practice="room_only"
            heading={
              <>
                Some things need a <span className="text-gold">doctor</span>.
              </>
            }
            body="Even in a room you rent, a few procedures need a medical director overseeing them. Tell Melanite what you'll be doing and it works out whether that applies to you."
            aside={{
              title: 'Why this matters',
              body: 'Melanite owns the room, so it carries the consequence of unsupervised work in it. This is the record of what you told us — nobody is checking up on you afterwards.',
            }}
          />
        }
      >
        <RoomProceduresForm initial={row.roomProcedures ?? []} />
      </StepShell>
    )
  }

  return (
    <StepShell
      current={5}
      rail={
        <ProgressRail
          current={5}
          heading={
            <>
              <span className="text-gold">Compliant</span> from day one.
            </>
          }
          body="Every laser provider needs a medical director overseeing treatments. Choose Melanite's for a simple monthly fee, or bring your own physician."
          aside={{
            title: 'Why this matters',
            body: "Medical oversight keeps you compliant with state regulations for laser procedures. Melanite's director plan includes protocol review and is required to accept bookings on the platform.",
          }}
        />
      }
    >
      <DirectorForm
        initialChoice={row?.type ?? null}
        subscriptionActive={row?.status === 'active'}
        justPaid={subscribed === '1'}
      />
    </StepShell>
  )
}
