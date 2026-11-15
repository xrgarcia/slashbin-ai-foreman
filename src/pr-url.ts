/** The pull request number in a `.../pull/<n>` URL, or undefined when the text names none. */
export function prNumberFromUrl(url: string): number | undefined {
  const n = /\/pull\/(\d+)/.exec(url)?.[1];
  return n ? Number(n) : undefined;
}
