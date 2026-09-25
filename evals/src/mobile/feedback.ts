import { createHash } from 'node:crypto';
import { MobileAutoAnswerer } from './auto-answer.ts';
import { MobileCanonicalGrader } from './canonical-grader.ts';
import type { MobileReport } from './report.ts';

export class MobileFeedbackMailbox {
  private readonly answerers = new Map<string, MobileAutoAnswerer>();
  private readonly graders = new Map<string, MobileCanonicalGrader>();
  private readonly receipts = new Map<string, unknown>();
  async process(report: MobileReport): Promise<unknown | null> {
    const probe = report.contracts?.mailboxRequest;
    if (probe) {
      if (typeof probe.id !== 'string' || typeof probe.content !== 'string')
        throw new Error('Invalid native contract mailbox request');
      return {
        requestId: probe.id,
        artifactSha256: createHash('sha256').update(probe.content).digest('hex'),
      };
    }

    const trial = [...report.trials]
      .reverse()
      .find((item) => item.status === 'running' && (item.assistanceRequest || item.gradeRequest));
    if (!trial) return null;
    const request = (trial.assistanceRequest || trial.gradeRequest) as { id: string };
    if (!request || typeof request.id !== 'string')
      throw new Error('Invalid native grading request');
    const key = `${report.runId}:${trial.id}:${request.id}`;
    const cached = this.receipts.get(key);
    if (cached) return cached;
    const trialKey = `${report.runId}:${trial.id}`;
    if (trial.assistanceRequest) {
      let answerer = this.answerers.get(trialKey);
      if (!answerer) {
        answerer = new MobileAutoAnswerer(trial.meesterId ?? 'unknown');
        this.answerers.set(trialKey, answerer);
      }
      let receipt: unknown;
      try {
        receipt = { requestId: request.id, assistance: await answerer.plan(trial) };
      } catch (error) {
        receipt = {
          requestId: request.id,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      this.receipts.set(key, receipt);
      return receipt;
    }
    let grader = this.graders.get(trialKey);
    if (!grader) {
      grader = new MobileCanonicalGrader(true);
      this.graders.set(trialKey, grader);
    }
    let receipt: unknown;
    try {
      receipt = { requestId: request.id, grade: await grader.grade(trial) };
    } catch (error) {
      receipt = {
        requestId: request.id,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    this.receipts.set(key, receipt);
    return receipt;
  }
}

/** Test-only transport. A grader failure becomes a native trial failure, never a passing skip. */
export async function runMobileFeedbackPump(options: {
  signal: AbortSignal;
  read: () => Promise<MobileReport | null>;
  write: (receipt: unknown) => Promise<void>;
  log: (line: string) => void;
}) {
  const mailbox = new MobileFeedbackMailbox();
  let lastReceipt = '';
  while (!options.signal.aborted) {
    try {
      const report = await options.read();
      if (report) {
        const receipt = await mailbox.process(report);
        if (receipt) {
          const encoded = JSON.stringify(receipt);
          if (encoded !== lastReceipt) {
            await options.write(receipt);
            lastReceipt = encoded;
            options.log(`Canonical host grader receipt delivered (${encoded.length} bytes)`);
          }
        }
      }
    } catch (error) {
      options.log(
        `Canonical mailbox transport: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (options.signal.aborted) break;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        options.signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, 1000);
      options.signal.addEventListener('abort', done, { once: true });
    });
  }
}
