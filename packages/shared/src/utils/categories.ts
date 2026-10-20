import type { Category, CategoryKind } from '../types/api'

/**
 * A category's kind, tolerating categories created before `kind` existed by falling
 * back to the legacy `is_expense` flag.
 */
export function categoryKindOf(
  category: Partial<Pick<Category, 'kind' | 'is_expense'>>,
): CategoryKind {
  return category.kind ?? (category.is_expense === false ? 'income' : 'expense')
}

/**
 * The label for a category in a picker or list. Names are unique per kind, so an income
 * and an expense category may share one: when another category in `all` (a different
 * id) has the same name, the kind is added, as in `Gifts (income)`. Otherwise the bare
 * name.
 */
export function categoryOptionLabel(
  category: Pick<Category, 'id' | 'name'> & Partial<Pick<Category, 'kind' | 'is_expense'>>,
  all: readonly Pick<Category, 'id' | 'name'>[],
): string {
  const shared = all.some((other) => other.id !== category.id && other.name === category.name)
  return shared ? `${category.name} (${categoryKindOf(category)})` : category.name
}
