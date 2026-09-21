/**
 * The one place that knows both review pipelines exist. `src/app.ts` (v1)
 * and `src/orchestration/app.ts` (council) each implement this interface
 * with no awareness of the other or of engine selection — this router is
 * the whole integration boundary, so neither src/server.ts nor either
 * pipeline needs an `if (engine === ...)` branch of its own.
 *
 * Only `review` jobs are engine-selectable today. `verify`, `reconsider`,
 * and `explain` always run through v1 regardless of HALF_SHELL_REVIEW_ENGINE,
 * because they depend on v1's PublishedFindingRecord store to resolve which
 * finding a reply belongs to — the council engine has no equivalent
 * cross-generation finding reconciliation yet (see the PR description).
 */
import type { ReviewEngineName } from './config.js';
import type { ReviewJob } from './types.js';

export interface ReviewEngineApp {
  enqueue(job: ReviewJob): Promise<void>;
  idle(): Promise<void>;
}

export class ReviewEngineRouter implements ReviewEngineApp {
  constructor(
    private readonly v1: ReviewEngineApp,
    private readonly council: ReviewEngineApp | undefined,
    private readonly engine: ReviewEngineName,
  ) {
    if (engine === 'council' && !council) {
      throw new Error('HALF_SHELL_REVIEW_ENGINE=council but no council engine was constructed');
    }
  }

  enqueue(job: ReviewJob): Promise<void> {
    if (this.engine === 'council' && job.kind === 'review' && this.council) {
      return this.council.enqueue(job);
    }
    return this.v1.enqueue(job);
  }

  async idle(): Promise<void> {
    await Promise.all([this.v1.idle(), this.council?.idle() ?? Promise.resolve()]);
  }
}
