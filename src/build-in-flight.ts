// Repos with a build session (implement or revise) pushing to the feature
// branch right now. The review stage reads it before adopting an open feature
// PR whose issues carry no review label yet: during a build that is the normal
// state, not an orphan — implement opens the PR and only labels it when the
// session ends. Since each stage got its own lane (df7ddf6) the review lane runs
// beside the build, and all 17 "adopted orphaned issue" warnings of 2026-10-14
// to 10-18 fired mid-build (jerky_service PR #196: adopted 70s before its build
// ended), handing the Tech Lead a branch still being pushed.
const building = new Map<string, number>();

export function buildStarted(repo: string): void {
  building.set(repo, (building.get(repo) ?? 0) + 1);
}

export function buildEnded(repo: string): void {
  const n = (building.get(repo) ?? 1) - 1;
  if (n > 0) building.set(repo, n);
  else building.delete(repo);
}

export function isBuildInFlight(repo: string): boolean {
  return building.has(repo);
}
