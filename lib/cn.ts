/** Joins class names, dropping falsey values.
 *
 * Deliberately not clsx + tailwind-merge: nothing here relies on later classes overriding
 * earlier ones, and two dependencies for a string join is not a trade worth making. Revisit
 * if components start needing to override each other's utilities.
 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}
