import { parentPort, workerData } from 'node:worker_threads';
import { Resvg } from '@resvg/resvg-js';

// One short-lived worker per wallpaper update. Both native rasterization and
// asPng() run here: renderAsync alone leaves large PNG encoding on the daemon.
const bytes = new Resvg(workerData as string).render().asPng();
parentPort!.postMessage(bytes);
