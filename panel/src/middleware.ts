import { NextResponse, type NextRequest } from 'next/server';
import { jwtVerify } from 'jose';

const COOKIE = 'paklean_session';
const KEY = new TextEncoder().encode(process.env.JWT_SECRET ?? '');

const PROTECTED = ['/dashboard', '/users', '/reports', '/account'];

export async function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  const needsAuth = PROTECTED.some(p => path === p || path.startsWith(p + '/'));
  if (!needsAuth) return NextResponse.next();

  const tok = req.cookies.get(COOKIE)?.value;
  if (!tok) return NextResponse.redirect(new URL('/login', req.url));
  try {
    await jwtVerify(tok, KEY);
    return NextResponse.next();
  } catch {
    const url = new URL('/login', req.url);
    return NextResponse.redirect(url);
  }
}

export const config = {
  matcher: ['/dashboard/:path*', '/users/:path*', '/reports/:path*', '/account/:path*'],
};
