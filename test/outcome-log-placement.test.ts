import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

// Where `<OutcomeLog>` sits in the tree, which is the whole of whether it works.
//
// THE BUG THIS EXISTS TO STOP, found on 14 October by charging a provider $70 and watching the
// screen say "Nothing waiting." The log was wrapped around the `<ul>` of queue rows, one branch
// inside `queue.length === 0 ? empty : list`. That survives resolving any item but the LAST
// one: emptying the queue swaps in the empty state and unmounts the log along with the list,
// taking the confirmation with it.
//
// A queue of this size is usually one item long, so the last item is the ordinary case, not the
// edge. The whole component exists because a confirmation that unmounts is a confirmation
// nobody reads — and it had been defeated by being mounted one level too deep.
//
// A SOURCE TEST, because there is no DOM here and this is a structural rule rather than a
// behaviour: the log must not live inside anything conditional on the list being non-empty.
// Same idiom and same reasoning as `use-server.test.ts` — invisible to tsc, invisible to eslint,
// and only visible in production at the moment it costs somebody a record of money moving.

// DISCOVERED rather than listed, so the next page to adopt the log is covered by this without
// anybody remembering to add it here. A hardcoded list would quietly stop checking the thing
// that matters the moment the component found a second home.
function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else if (path.endsWith('.tsx')) out.push(path)
  }
  return out
}

describe('the outcome log outlives what it reports on', () => {
  const users = walk('app').filter((p) => readFileSync(p, 'utf8').includes('<OutcomeLog>'))

  it('is actually used somewhere, so this test is checking something', () => {
    expect(users.length).toBeGreaterThan(0)
  })

  it.each(users)('%s opens the log before any emptiness check', (path) => {
    const source = readFileSync(path, 'utf8')

    const log = source.indexOf('<OutcomeLog>')
    // The shape that goes wrong: a ternary or a guard keyed on the list being empty. If one of
    // those opens BEFORE the log, the log is inside a branch and dies with it.
    const emptyCheck = source.search(/\.length === 0 \?|\.length > 0 &&/)

    expect(log, 'the log must open before the empty-state branch, not inside it').toBeLessThan(
      emptyCheck === -1 ? Number.MAX_SAFE_INTEGER : emptyCheck,
    )
  })
})
