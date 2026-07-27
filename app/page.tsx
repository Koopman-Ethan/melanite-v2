import { redirect } from 'next/navigation'

/** `/` is not a page in v2.
 *
 *  Marketing stays on Webflow — this app owns /app/* and /pay/* only — so the root exists
 *  purely to route into the portal. Signed in, /app forwards to whichever home the role has;
 *  signed out, proxy.ts bounces to /login. Either way nobody lands on a dead end.
 */
export default function RootIndex() {
  redirect('/app')
}
