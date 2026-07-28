// Parsing an env file we wrote ourselves.
//
// Not a general dotenv implementation and not trying to be. It handles the shape our own files
// take — KEY=value, comments, blank lines, optional surrounding quotes — and ignores anything
// else rather than guessing. The alternative was reaching for a transitive dependency of
// @next/env, which would work right up until Next reorganised its bundle.
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}

  for (const raw of text.split(/\r?\n/)) {
    // A comment line, a blank, or anything that is not KEY=… is skipped in silence. An env file
    // is edited by hand, at night, and a parse error that halts a production migration over a
    // stray line would be a worse failure than ignoring it.
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw)
    if (!match) continue

    let value = match[2].trim()
    const quoted =
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    if (quoted) value = value.slice(1, -1)

    out[match[1]] = value
  }

  return out
}
