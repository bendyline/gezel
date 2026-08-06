import { describe, expect, it } from 'vitest';
import { extractEngineContext } from './engine-context.ts';

/**
 * Contract pins for the service log lines the extractor reads (same
 * eval-side pinning pattern as capacity-contract.test.ts). Sources of
 * truth, in lockstep with which these fixtures must change:
 *
 * - launch line: packages/service/src/chat/manager.ts `[llama-server] launch`
 * - clamp reason: packages/service/src/providers/native/capacity-broker.ts
 *   `clampCtxTokensForMemory`
 * - denial text: capacity-broker.ts `formatContextCapacityDenial`
 * - swa decline: manager.ts `buildLlamaCppProvider` (Gemma auto-default gate)
 */
const LAUNCH_65536 =
  '2026-08-06T02:29:12.856Z INFO  [chat] [llama-server] launch {"pid":37538,"command":"gezel-llama-server","nativeRelease":"0.1.31","model":"gemma4-31b-q4","backend":"metal","upstreamRevision":"1a064ab0921238c1daa397d6f4a900ef33884de2","cudaArchitectures":"unknown","gpu":"Apple M4 Max","contextPerSlot":65536,"contextTotal":65536,"slots":1,"kvCacheType":"f16","batchSize":"default","ubatchSize":"512","flashAttention":"default","cudaGraphs":"default"}';
const LAUNCH_8192 =
  '2026-08-04T06:45:20.000Z INFO  [chat] [llama-server] launch {"pid":1234,"command":"gezel-llama-server","model":"qwen3.6-27b-q4","contextPerSlot":8192,"contextTotal":8192,"slots":1,"kvCacheType":"f16"}';
const CLAMP_12288 =
  '2026-08-06T02:29:10.000Z WARN  [chat] [llama-cpp] gemma4-31b-q4: context clamped 65536 → 12288 tokens/turn (1 slot): weights ~19.6 GB + KV at the requested context ~105.0 GB exceeds available memory ~44.8 GB (budget 44.8 GB, live free RAM 57.6 GB); KV now ~19.7 GB. Sessions compact sooner instead of the machine paging.';
const DENIAL =
  '2026-08-06T02:29:10.000Z ERROR [chat] Not enough memory to run Gemma 4 31B with its required 65,536-token working window. Even at one engine slot, this machine could safely admit only about 12,288 tokens per turn.';
const SWA_DECLINE =
  '2026-08-06T01:38:07.073Z WARN  [chat] [llama-cpp] gemma4-31b-q4: full-attention KV at the requested 65536-token total context does not fit — keeping the full context and declining the --swa-full auto-default instead; the windowed KV cache is what actually fits (cross-request prefix reuse unavailable). Fit detail: context clamped 65536 → 12288 tokens/turn (1 slot): weights ~19.6 GB + KV at the requested context ~105.0 GB exceeds available memory ~44.8 GB (budget 44.8 GB, live free RAM 57.6 GB); KV now ~19.7 GB. Sessions compact sooner instead of the machine paging.';

describe('extractEngineContext', () => {
  it('returns null for empty/absent logs and logs without engine evidence', () => {
    expect(extractEngineContext(null)).toBeNull();
    expect(extractEngineContext('')).toBeNull();
    expect(extractEngineContext('INFO [chat] [mlx] launch {"pid":1,"command":"python"}')).toBeNull();
  });

  it('reads the launch line into granted context (contract pin)', () => {
    const record = extractEngineContext(LAUNCH_65536);
    expect(record).toMatchObject({
      grantedPerSlotTokens: 65536,
      totalTokens: 65536,
      slots: 1,
      kvCacheType: 'f16',
      launchModel: 'gemma4-31b-q4',
      launches: 1,
    });
    expect(record?.clamp).toBeUndefined();
    expect(record?.clampBypassed).toBeUndefined();
  });

  it('the LAST launch wins when the engine restarts mid-trial', () => {
    const record = extractEngineContext([LAUNCH_65536, LAUNCH_8192].join('\n'));
    expect(record?.grantedPerSlotTokens).toBe(8192);
    expect(record?.launchModel).toBe('qwen3.6-27b-q4');
    expect(record?.launches).toBe(2);
  });

  it('reads the clamp reason (contract pin) and pairs it with the launch', () => {
    const record = extractEngineContext([CLAMP_12288, LAUNCH_8192].join('\n'));
    expect(record?.clamp).toEqual({ requestedTokens: 65536, grantedTokens: 12288 });
    expect(record?.clampBypassed).toBeUndefined();
  });

  it('flags the admission-bypass signature: clamp verdict + higher launch (2026-08-05 OOM shape)', () => {
    const record = extractEngineContext([CLAMP_12288, LAUNCH_65536].join('\n'));
    expect(record).toMatchObject({
      grantedPerSlotTokens: 65536,
      clamp: { requestedTokens: 65536, grantedTokens: 12288 },
      clampBypassed: true,
    });
  });

  it('reads the capacity denial (contract pin) even with no launch line', () => {
    const record = extractEngineContext(DENIAL);
    expect(record).toMatchObject({ capacityDenied: true, launches: 0 });
    expect(record?.grantedPerSlotTokens).toBeUndefined();
  });

  it('reads the Gemma swa-full decline (contract pin) without misreading its embedded fit detail as a clamp', () => {
    const record = extractEngineContext([SWA_DECLINE, LAUNCH_65536].join('\n'));
    expect(record).toMatchObject({ swaFullDeclined: true, grantedPerSlotTokens: 65536 });
    expect(record?.clamp).toBeUndefined();
    expect(record?.clampBypassed).toBeUndefined();
  });

  it('skips unparsable launch payloads instead of guessing', () => {
    const truncated = 'INFO [chat] [llama-server] launch {"pid":1,"contextPerSlot":655';
    expect(extractEngineContext(truncated)).toBeNull();
    const record = extractEngineContext([truncated, LAUNCH_8192].join('\n'));
    expect(record?.grantedPerSlotTokens).toBe(8192);
  });
});
