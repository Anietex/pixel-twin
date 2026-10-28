/** An error from the browser side whose message is already in plain words. */
export class PageError extends Error {}

/** The first line of an error, without Playwright's "Call log" or its "locator.count: " style prefix. */
function firstLine(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.split('\n')[0].replace(/^[\w.]+: /, '').trim();
}

/** Plain words for a failure while opening, measuring or picturing the page. */
export function measureFailure(err: unknown): string {
  if (err instanceof PageError) return err.message;
  return `Pixel Twin couldn't measure the page: ${firstLine(err)}`;
}

/** True when Playwright refused the selector itself, not the page. */
export function isSelectorError(err: unknown): boolean {
  return /while parsing .*selector|is not a valid selector/i.test(firstLine(err));
}

/** Runs one browser step and turns any failure into a PageError in plain words. */
export async function inBrowser<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (err) {
    throw new PageError(measureFailure(err));
  }
}
