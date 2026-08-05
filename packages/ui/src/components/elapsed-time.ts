export function formatElapsedClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const remainingSeconds = String(total % 60).padStart(2, '0');
  return minutes > 0 ? `${minutes}:${remainingSeconds}` : `:${remainingSeconds}`;
}
