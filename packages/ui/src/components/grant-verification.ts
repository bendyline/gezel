const VERIFICATION_CODE_PATTERN = /^[2-9A-HJ-KM-NP-TV-Z]{3}-[2-9A-HJ-KM-NP-TV-Z]{3}$/;

export function formatVerificationCode(value: string): string {
  const raw = value
    .toUpperCase()
    .replace(/[^2-9A-HJ-KM-NP-TV-Z]/g, '')
    .slice(0, 6);
  return raw.length > 3 ? `${raw.slice(0, 3)}-${raw.slice(3)}` : raw;
}

export function isVerificationCodeReady(value: string): boolean {
  return VERIFICATION_CODE_PATTERN.test(value);
}

export async function approvalErrorMessage(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as {
    error?: string;
    attemptsRemaining?: number;
  } | null;
  if (body?.error === 'verification_code_required') {
    return 'Enter the code shown by the requesting application.';
  }
  if (body?.error === 'verification_code_invalid') {
    const attempts = body.attemptsRemaining;
    return `That code did not match.${
      typeof attempts === 'number'
        ? ` ${attempts} attempt${attempts === 1 ? '' : 's'} remaining.`
        : ''
    }`;
  }
  if (body?.error === 'verification_attempts_exceeded') {
    return 'Too many incorrect codes. This request has expired; start the connection again.';
  }
  if (body?.error === 'grant_expired') {
    return 'This request has expired. Start the connection again to get a new code.';
  }
  return `${fallback}: HTTP ${response.status}`;
}
