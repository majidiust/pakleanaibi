import * as OTPAuth from 'otpauth';
import QRCode from 'qrcode';
import { SignJWT, jwtVerify } from 'jose';
import { env } from './env';

// We use TOTP (RFC 6238) compatible with Google Authenticator, 1Password,
// Authy, etc. Drift of ±1 30-second window is tolerated.
const ISSUER = 'Paklean BI';
const PENDING_AUD = 'paklean-totp-pending';
let _key: Uint8Array | null = null;
function key(): Uint8Array {
  if (!_key) _key = new TextEncoder().encode(env.JWT_SECRET);
  return _key;
}

export interface PendingTotpClaims {
  sub: string;
  email: string;
  name: string;
  role: 'admin' | 'analyst' | 'viewer';
}

export function generateSecret(): string {
  return new OTPAuth.Secret({ size: 20 }).base32;
}

export function buildOtpAuthUri(email: string, secretBase32: string): string {
  const totp = new OTPAuth.TOTP({
    issuer: ISSUER,
    label: email,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
  return totp.toString();
}

export async function buildQrDataUrl(uri: string): Promise<string> {
  return QRCode.toDataURL(uri, { errorCorrectionLevel: 'M', margin: 1, scale: 6 });
}

export function verifyCode(secretBase32: string, code: string): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const totp = new OTPAuth.TOTP({
    issuer: ISSUER,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
  // window=1 -> accepts current ±30s. delta is null if no match.
  const delta = totp.validate({ token: code, window: 1 });
  return delta !== null;
}

export async function signPending(claims: PendingTotpClaims): Promise<string> {
  return new SignJWT({ email: claims.email, name: claims.name, role: claims.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setAudience(PENDING_AUD)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key());
}

export async function verifyPending(token: string): Promise<PendingTotpClaims | null> {
  try {
    const { payload } = await jwtVerify(token, key(), { audience: PENDING_AUD });
    if (!payload.sub) return null;
    return {
      sub: String(payload.sub),
      email: String(payload.email ?? ''),
      name: String(payload.name ?? ''),
      role: (payload.role as PendingTotpClaims['role']) ?? 'viewer',
    };
  } catch {
    return null;
  }
}
