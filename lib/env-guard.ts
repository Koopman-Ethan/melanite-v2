// Which database am I about to write to, and did anybody actually say so?
//
// Several scripts here are destructive by design: the ETL loader truncates and repopulates,
// the scrubber rewrites every client's details, the seeder invents data. Run one against
// production by accident and there is no undo — the ledger is append-only precisely because
// money history should not be editable, which also means a bad write cannot be tidied away.
//
// The obvious guards are all weak:
//
//   - Matching the connection string for "prod". A Neon URL is
//     `ep-old-paper-a6ligt30.us-west-2.aws.neon.tech`, which contains no such word. The
//     scrubber shipped with exactly this check and it protected nothing.
//   - Inferring from the git branch. Tempting, and wrong: I spent most of a day pushing to
//     `Ethan/Testing` while HEAD was on `Ethan/Phase1` and reported success every time. A
//     branch says where the code is, never where the data is.
//   - NODE_ENV. Every local run is `development` regardless of which database is configured.
//
// So it is stated, not inferred. `MELANITE_ENV` sits beside `DATABASE_URL` in the same file,
// which makes it as hard to get wrong as the connection string itself: copy one without the
// other and the guard fires.

export type MelaniteEnv = 'dev' | 'prod'

export class WrongEnvironmentError extends Error {}

/** What the configured environment claims to be. */
export function currentEnv(): MelaniteEnv | null {
  const value = process.env.MELANITE_ENV?.trim().toLowerCase()
  if (value === 'dev' || value === 'prod') return value
  return null
}

/** A human-readable host, for messages. Never the credentials. */
export function describeDatabase(): string {
  return /@([^/?]+)/.exec(process.env.DATABASE_URL ?? '')?.[1] ?? 'an unknown host'
}

/**
 * Refuses to continue unless the configured environment is one of `allowed`.
 *
 * An ABSENT value is refused too, and that is the important half. Treating "unset" as safe
 * would mean every environment that predates this guard — including whatever gets configured
 * in a hurry on migration night — is silently exempt from it.
 */
export function requireEnv(allowed: MelaniteEnv[], action: string): MelaniteEnv {
  const env = currentEnv()

  if (env === null) {
    throw new WrongEnvironmentError(
      [
        `Refusing to ${action}: MELANITE_ENV is not set.`,
        ``,
        `  Database: ${describeDatabase()}`,
        ``,
        `  Add MELANITE_ENV=dev (or prod) to the same env file as DATABASE_URL. It is`,
        `  deliberately not inferred — a branch name says where the code is, never where`,
        `  the data is.`,
      ].join('\n'),
    )
  }

  if (!allowed.includes(env)) {
    throw new WrongEnvironmentError(
      [
        `Refusing to ${action}.`,
        ``,
        `  MELANITE_ENV: ${env}`,
        `  Database:     ${describeDatabase()}`,
        ``,
        `  This is only allowed in: ${allowed.join(', ')}.`,
      ].join('\n'),
    )
  }

  return env
}

/**
 * For the few things that genuinely must run against production — the migration itself.
 *
 * Requires MELANITE_ENV=prod AND an explicit `--i-know-this-is-production` on the command
 * line. Two independent statements, because one of them alone is something a person can do
 * without noticing: an env file left over from yesterday, or a flag copied from a runbook.
 */
export function requireProductionOptIn(action: string): void {
  requireEnv(['prod'], action)

  if (!process.argv.includes('--i-know-this-is-production')) {
    throw new WrongEnvironmentError(
      [
        `Refusing to ${action} against PRODUCTION.`,
        ``,
        `  Database: ${describeDatabase()}`,
        ``,
        `  MELANITE_ENV says prod, which is necessary and not sufficient. Re-run with`,
        `  --i-know-this-is-production if that is genuinely what you mean.`,
      ].join('\n'),
    )
  }
}
