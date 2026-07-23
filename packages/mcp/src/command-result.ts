export function commandResultIsError(result: {
  ok: boolean;
  approvalPending?: boolean;
}): boolean {
  return !result.ok && result.approvalPending !== true;
}
