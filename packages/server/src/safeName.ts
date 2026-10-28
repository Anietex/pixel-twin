/** Makes an id or label safe for a file name: keeps 0-9 A-Z a-z ; _ - and turns everything else into '-'. */
export function safeName(value: string): string {
  return value.replace(/[^0-9A-Za-z;_-]/g, '-');
}
