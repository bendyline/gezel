import type { ProviderUsage, QuotaBucket } from '@bendyline/gezel-client';

export function ProviderUsagePanel({ label, data }: { label: string; data: ProviderUsage }) {
  return (
    <div className="provider-usage-panel">
      <h4 className="provider-usage-heading">{label}</h4>
      <div className="usage-grid">
        {data.quotaBuckets.map((b) => (
          <QuotaBucketCard key={b.name} bucket={b} />
        ))}
        <div className="usage-card">
          <div className="usage-label">Today</div>
          <div className="usage-value">{data.todayTurns} turns</div>
          <div className="usage-detail">
            <span>
              {data.todayTokensIn.toLocaleString()} in / {data.todayTokensOut.toLocaleString()} out
              tokens
            </span>
          </div>
        </div>
        <div className="usage-card">
          <div className="usage-label">Since startup</div>
          <div className="usage-value">{data.totalTurns} turns</div>
          <div className="usage-detail">
            <span>
              {data.totalTokensIn.toLocaleString()} in / {data.totalTokensOut.toLocaleString()} out
              tokens
            </span>
          </div>
        </div>
        {/* Decode speed. Only the on-device engines report throughput, so this
            card is omitted entirely for cloud providers rather than showing a
            zero that reads as a measurement. */}
        {typeof data.medianOutputTokensPerSec === 'number' && (
          <div className="usage-card">
            <div className="usage-label">Decode speed</div>
            <div className="usage-value">{data.medianOutputTokensPerSec} tok/s</div>
            <div className="usage-detail">
              <span>median across turns, generation only</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function QuotaBucketCard({ bucket }: { bucket: QuotaBucket }) {
  if (bucket.isUnlimited) {
    return (
      <div className="usage-card usage-card-wide">
        <div className="usage-label">{humanizeBucketName(bucket.name)}</div>
        <div className="usage-value">Unlimited</div>
      </div>
    );
  }
  const used = Math.round((1 - bucket.remainingPercent) * 100);
  return (
    <div className="usage-card usage-card-wide">
      <div className="usage-label">{humanizeBucketName(bucket.name)}</div>
      <div className="usage-bar-track">
        <div
          className={`usage-bar-fill${used > 80 ? ' usage-bar-warn' : ''}`}
          style={{ width: `${Math.min(used, 100)}%` }}
        />
      </div>
      <div className="usage-detail">
        <span>
          {bucket.used.toLocaleString()} / {bucket.limit.toLocaleString()} ({used}%)
        </span>
        <span>
          {bucket.remaining.toLocaleString()} remaining
          {bucket.resetDate ? ` · resets ${bucket.resetDate}` : ''}
        </span>
      </div>
      {bucket.overage > 0 && (
        <div className="usage-overage">{bucket.overage.toLocaleString()} overage</div>
      )}
    </div>
  );
}

function humanizeBucketName(name: string): string {
  return name.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
