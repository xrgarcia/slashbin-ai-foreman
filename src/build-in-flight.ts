// Repos with a build session (implement or revise) pushing to the feature
// branch right now. The review stage reads it before adopting an open feature
// PR whose issues carry no review label yet: during a build that is the normal
// state, not an orphan — implement opens the PR and only labels it when the
// session ends. Since each stage got its own lane (df7ddf6) the review lane runs
// beside the build, and all 17 "adopted orphaned issue" warnings of 2026-10-14
// to 10-18 fired mid-build (jerky_service PR #196: adopted 70s before its build
// ended), handing the Tech Lead a branch still being pushed.
export class BuildsInFlight {
  private readonly building = new Map<string, number>();

  started(repo: string): void {
    this.building.set(repo, (this.building.get(repo) ?? 0) + 1);
  }

  ended(repo: string): void {
    const n = (this.building.get(repo) ?? 1) - 1;
    if (n > 0) this.building.set(repo, n);
    else this.building.delete(repo);
  }

  isInFlight(repo: string): boolean {
    return this.building.has(repo);
  }
}
