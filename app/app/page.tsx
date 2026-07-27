import { redirect } from 'next/navigation'

import { requireProvider } from '@/lib/auth/dal'
import { dashboardHref } from '@/lib/nav'

/** `/app` is not a screen — it routes to whichever home the role has. v1 did this with a
 *  `dashTarget` function inside the client-side nav wiring; here it is a server redirect, so
 *  nobody briefly lands somewhere they cannot use. */
export default async function AppIndex() {
  const user = await requireProvider()
  redirect(dashboardHref(user))
}
