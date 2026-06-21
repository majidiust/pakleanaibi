import { SignJWT, jwtVerify } from 'jose';
import bcrypt from 'bcryptjs';
import { cookies } from 'next/headers';
import { ObjectId } from 'mongodb';
import { biDb } from './mongo';
import { env } from './env';

export const COOKIE = 'paklean_session';
const KEY = new TextEncoder().encode(env.JWT_SECRET);

export type Role = 'admin' | 'analyst' | 'viewer';
export interface SessionUser {
  sub: string;
  email: string;
  name: string;
  role: Role;
}

export async function hashPassword(p: string): Promise<string> {
  return bcrypt.hash(p, 10);
}
export async function checkPassword(p: string, hash: string): Promise<boolean> {
  return bcrypt.compare(p, hash);
}

export async function signSession(u: SessionUser): Promise<string> {
  return new SignJWT({ email: u.email, name: u.name, role: u.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(u.sub)
    .setIssuedAt()
    .setExpirationTime(`${env.JWT_TTL_HOURS}h`)
    .sign(KEY);
}

export async function verifySession(token: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, KEY);
    if (!payload.sub) return null;
    return {
      sub: String(payload.sub),
      email: String(payload.email ?? ''),
      name: String(payload.name ?? ''),
      role: (payload.role as Role) ?? 'viewer',
    };
  } catch {
    return null;
  }
}

export async function currentUser(): Promise<SessionUser | null> {
  const token = cookies().get(COOKIE)?.value;
  if (!token) return null;
  return verifySession(token);
}

export async function requireUser(): Promise<SessionUser> {
  const u = await currentUser();
  if (!u) throw new Response('Unauthorized', { status: 401 });
  return u;
}

export async function requireRole(...roles: Role[]): Promise<SessionUser> {
  const u = await requireUser();
  if (!roles.includes(u.role)) throw new Response('Forbidden', { status: 403 });
  return u;
}

export async function findUserByEmail(email: string) {
  const db = await biDb();
  return db.collection('users').findOne({ email: email.toLowerCase() });
}

export async function findUserById(id: string) {
  if (!ObjectId.isValid(id)) return null;
  const db = await biDb();
  return db.collection('users').findOne({ _id: new ObjectId(id) });
}
