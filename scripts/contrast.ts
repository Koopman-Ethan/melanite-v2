// Checks every design token against the surfaces it is actually used on.
//
//   npm run a11y:contrast
//
// Exists because contrast is the one accessibility property you cannot eyeball, especially on a
// dark theme where everything looks "fine" to someone with good eyes on a good monitor. The
// tokens are read from globals.css rather than duplicated here, so this cannot drift from what
// ships.
//
// WCAG 2.1 thresholds: 4.5:1 for normal text, 3:1 for large text (18.66px+, or 14px+ bold) and
// for non-text UI such as borders, icons and focus indicators.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const AA_NORMAL = 4.5
const AA_LARGE = 3

type Rgb = [number, number, number]

function parse(hex: string): Rgb {
  const h = hex.replace('#', '')
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ]
}

/** WCAG relative luminance. */
function luminance([r, g, b]: Rgb): number {
  const channel = (v: number) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function ratio(fg: string, bg: string): number {
  const a = luminance(parse(fg))
  const b = luminance(parse(bg))
  const [hi, lo] = a > b ? [a, b] : [b, a]
  return (hi + 0.05) / (lo + 0.05)
}

function readTokens(): Record<string, string> {
  const css = readFileSync(join(process.cwd(), 'app', 'globals.css'), 'utf8')
  const tokens: Record<string, string> = {}
  for (const [, name, value] of css.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)) {
    tokens[name] = value
  }
  return tokens
}

/** Foreground tokens paired with the surfaces they actually appear on, and the size they are
 *  used at. Text smaller than 18.66px must clear 4.5:1 — most of this app's metadata is 12px
 *  or 10px, which is exactly where a dark theme quietly fails. */
const CHECKS: { fg: string; bg: string; use: string; threshold: number }[] = [
  { fg: 'ink', bg: 'canvas', use: 'body text', threshold: AA_NORMAL },
  { fg: 'ink', bg: 'surface', use: 'card text', threshold: AA_NORMAL },
  { fg: 'ink-secondary', bg: 'surface', use: 'labels, secondary copy', threshold: AA_NORMAL },
  { fg: 'ink-muted', bg: 'surface', use: 'section headings, hints', threshold: AA_NORMAL },
  { fg: 'ink-faint', bg: 'surface', use: 'metadata at 10–12px', threshold: AA_NORMAL },
  { fg: 'ink-faint', bg: 'canvas', use: 'page-level metadata', threshold: AA_NORMAL },
  { fg: 'ink-muted', bg: 'raised', use: 'sidebar labels', threshold: AA_NORMAL },
  { fg: 'ink-faint', bg: 'overlay', use: 'text in confirm panels', threshold: AA_NORMAL },
  { fg: 'gold', bg: 'surface', use: 'links and accents', threshold: AA_NORMAL },
  { fg: 'gold', bg: 'canvas', use: 'nav active state', threshold: AA_NORMAL },
  { fg: 'gold-ink', bg: 'gold', use: 'text on gold buttons', threshold: AA_NORMAL },
  { fg: 'success', bg: 'surface', use: 'success text', threshold: AA_NORMAL },
  { fg: 'info', bg: 'surface', use: 'info text', threshold: AA_NORMAL },
  { fg: 'warning', bg: 'surface', use: 'warning text', threshold: AA_NORMAL },
  { fg: 'danger', bg: 'surface', use: 'error text', threshold: AA_NORMAL },
  // `critical` is a BACKGROUND with white text on it, so the pair that matters is ink ON
  // critical — measuring critical against the page was measuring the wrong direction.
  { fg: 'ink', bg: 'critical', use: 'text on destructive button', threshold: AA_NORMAL },
  // `danger` is only ever a tint behind `text-danger`, or a solid dot. There is no white-on-
  // solid-danger anywhere, so that pair is not checked — a threshold on a combination that does
  // not exist is noise that trains you to ignore the output.
  // Non-text: control boundaries and the focus ring need 3:1 (WCAG 1.4.11). Decorative card
  // borders are deliberately NOT checked — they identify nothing, and holding them to 3:1 on a
  // dark theme would mean drawing every card in near-grey.
  { fg: 'line-control', bg: 'surface', use: 'input and button borders', threshold: AA_LARGE },
  { fg: 'line-control', bg: 'canvas', use: 'control borders on the page', threshold: AA_LARGE },
  { fg: 'gold', bg: 'canvas', use: 'focus ring (non-text)', threshold: AA_LARGE },
]

function main() {
  const tokens = readTokens()
  let failures = 0

  console.log('\ncontrast against WCAG 2.1 AA\n')

  for (const check of CHECKS) {
    const fg = tokens[check.fg]
    const bg = tokens[check.bg]
    if (!fg || !bg) {
      console.log(`  ?  ${check.fg} on ${check.bg} — token missing`)
      failures += 1
      continue
    }

    const r = ratio(fg, bg)
    const pass = r >= check.threshold
    if (!pass) failures += 1

    console.log(
      `  ${pass ? 'ok  ' : 'FAIL'} ${r.toFixed(2).padStart(5)}:1  (needs ${check.threshold})  ` +
        `${check.fg} on ${check.bg} — ${check.use}`,
    )
  }

  console.log(
    failures === 0
      ? '\nAll pairs pass.\n'
      : `\n${failures} pair(s) below threshold.\n`,
  )
  if (failures > 0) process.exitCode = 1
}

main()
