/**
 * The middle of the playing field: for now a placeholder, one thin ink line across the table
 * (`.ct-divider` in table.css). The user will supply what replaces it; swap this one element.
 * Decorative.
 */
export function TableDivider() {
  return <div aria-hidden="true" className="ct-divider" data-testid="table-divider" />;
}
