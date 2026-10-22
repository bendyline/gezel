import { type GraphLayoutEngine, createWorkerLayoutEngine } from '@bendyline/squisq-graph';
import LayoutWorker from '@bendyline/squisq-graph/worker?worker';

let engine: GraphLayoutEngine | null = null;

/**
 * One layout worker for every Diagram, started on the first layout. Where a
 * worker cannot start (tests, a blocked asset) the engine lays out on this
 * thread instead.
 */
export function diagramLayoutEngine(): GraphLayoutEngine {
  engine ??= createWorkerLayoutEngine({ workerFactory: () => new LayoutWorker() });
  return engine;
}
