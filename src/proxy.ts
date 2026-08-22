import { NextResponse, type NextRequest } from "next/server";

export function proxy(request: NextRequest) {
  const backend = process.env.CINEFORGE_BACKEND_URL?.trim();
  if (!backend) return NextResponse.next();

  const target = new URL(`${request.nextUrl.pathname}${request.nextUrl.search}`, backend);
  if (target.origin === request.nextUrl.origin) return NextResponse.next();

  const requestHeaders = new Headers(request.headers);
  requestHeaders.delete("host");
  requestHeaders.set("x-cineforge-desktop-client", "1");
  return NextResponse.rewrite(target, { request: { headers: requestHeaders } });
}

export const config = {
  matcher: "/api/:path*",
};
