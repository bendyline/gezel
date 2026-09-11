import { createHash } from 'node:crypto';
import type { Session } from 'electron';

export type CertificateVerifyHandler = NonNullable<
  Parameters<Session['setCertificateVerifyProc']>[0]
>;

export interface CertificateVerifySession {
  setCertificateVerifyProc(handler: CertificateVerifyHandler | null): void;
}

export interface LoopbackCertificatePin {
  install(rendererSession: CertificateVerifySession): void;
  setCertificate(certPem: string | null): void;
}

/**
 * Pin Electron's loopback TLS trust to the daemon certificate selected by the
 * supervisor. The pin can rotate independently when the daemon restarts.
 */
export function createLoopbackCertificatePin(): LoopbackCertificatePin {
  let fingerprint: string | null = null;

  return {
    install(rendererSession) {
      rendererSession.setCertificateVerifyProc((request, callback) => {
        const isLoopback =
          request.hostname === '127.0.0.1' ||
          request.hostname === '::1' ||
          request.hostname === 'localhost';
        if (!isLoopback) {
          // Defer to Chromium's normal validation for non-loopback hosts.
          callback(-3);
          return;
        }
        if (!fingerprint) {
          // Loopback requests fail closed before the supervisor supplies a pin.
          callback(-2);
          return;
        }
        const received = request.certificate.fingerprint.replace(/^sha256\//, '');
        callback(received === fingerprint ? 0 : -2);
      });
    },

    setCertificate(certPem) {
      if (!certPem) {
        fingerprint = null;
        return;
      }
      const derBody = certPem
        .split('\n')
        .filter((line) => !line.startsWith('-----') && line.trim().length > 0)
        .join('');
      fingerprint = createHash('sha256').update(Buffer.from(derBody, 'base64')).digest('base64');
    },
  };
}
