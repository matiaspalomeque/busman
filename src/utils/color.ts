/** Accept only #RGB or #RRGGBB hex color values. */
export function safeColor(c: string | undefined): string | undefined {
  return c && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(c) ? c : undefined;
}
