// Grouping a service list for a <select>.
//
// Laser hair removal went from four sizes to twelve named body areas, which took the catalogue
// from fifteen options to twenty-three. A flat list that long is one somebody scrolls rather
// than reads, and the twelve that belong together are only adjacent by luck of the alphabet.
//
// Shared by the booking form and the My Services picker so the two cannot group differently —
// a provider who learns the shape of one list should recognise the other.

export interface Groupable {
  category: string | null
}

export interface ServiceGroup<T> {
  /** Null for the ungrouped bucket. Rendered as plain options, not under a heading called
   *  "Other" — a heading invents a category the catalogue does not have. */
  category: string | null
  items: T[]
}

/**
 * Splits a list into `<optgroup>`s, preserving the order it arrives in.
 *
 * The ORDER IS THE QUERY'S, not this function's. Both callers sort by category then name in
 * SQL, and re-sorting here would mean two places deciding the same thing and eventually
 * disagreeing. All this does is bracket runs of the same category.
 *
 * Ungrouped services always come last, whatever order they arrived in. A service with no
 * category is one nobody has filed yet, and burying it mid-list is how it stops being noticed.
 */
export function groupByCategory<T extends Groupable>(items: T[]): ServiceGroup<T>[] {
  const groups: ServiceGroup<T>[] = []

  for (const item of items) {
    const last = groups[groups.length - 1]
    if (last && last.category === item.category) {
      last.items.push(item)
    } else {
      groups.push({ category: item.category, items: [item] })
    }
  }

  // A single group is not a grouping. One <optgroup> around the entire list adds a heading that
  // says nothing the list does not already say — and here it says it twice, because a heading
  // reading "Laser hair removal" over twelve options each named "Laser Hair Removal — …" is
  // pure noise. Dropping the category renders them as plain options.
  if (groups.length <= 1) return groups.map((g) => ({ ...g, category: null }))

  return [
    ...groups.filter((g) => g.category !== null),
    ...groups.filter((g) => g.category === null),
  ]
}
