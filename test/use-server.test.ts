import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

// A `'use server'` module may only export ASYNC functions.
//
// This has now caught me three times, and it is invisible to everything else: tsc compiles it,
// eslint passes it, the unit tests pass because vitest ignores the directive. It only fails
// when Next builds the module — at which point EVERY page returns 500, because the whole route
// tree depends on it. The last occurrence took the entire app down and was found by an
// unrelated Playwright login timing out.
//
// So the rule gets a test. Extracting pure logic to lib/ is the fix each time; this is what
// says so before the app is broken rather than after.

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else if (path.endsWith('.ts') || path.endsWith('.tsx')) out.push(path)
  }
  return out
}

const serverActionFiles = walk('app').filter((path) => {
  const head = readFileSync(path, 'utf8').slice(0, 200)
  return /^\s*['"]use server['"]/.test(head)
})

describe("'use server' modules", () => {
  it('exist, so this test is actually checking something', () => {
    // Guards against the walk silently matching nothing after a refactor.
    expect(serverActionFiles.length).toBeGreaterThan(5)
  })

  it.each(serverActionFiles)('%s exports only async functions', (path) => {
    const source = readFileSync(path, 'utf8')

    // Types and interfaces are erased at compile time, so they are fine to export. Anything
    // else — a sync function, a const, a class — is not.
    const offenders = source
      .split('\n')
      .map((line, i) => ({ line: line.trim(), number: i + 1 }))
      .filter(({ line }) => /^export\s/.test(line))
      .filter(({ line }) => !/^export\s+(async\s+function|type|interface)\b/.test(line))
      .filter(({ line }) => !/^export\s+\{[^}]*\}\s+from/.test(line))
      .map(({ line, number }) => `${path}:${number} — ${line}`)

    expect(
      offenders,
      `\nA 'use server' file may only export async functions. Move pure logic to lib/:\n${offenders.join('\n')}\n`,
    ).toEqual([])
  })
})
