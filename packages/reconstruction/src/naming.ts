/** `orders-api` -> `OrdersApi`; non-alphanumerics split words; a leading digit gets an `A` prefix. */
export function toPascalCase(input: string): string {
  const words = input.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const pascal = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
  if (pascal.length === 0) return 'Unnamed';
  return /^[0-9]/.test(pascal) ? `A${pascal}` : pascal;
}

/** Lowercase, hyphen-separated identifier safe for IDs and file names. */
export function slug(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'unnamed'
  );
}
