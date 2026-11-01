import { toNextJsHandler } from 'better-auth/next-js';
import { getAuth } from '@/lib/server';

export const dynamic = 'force-dynamic';

const handler = () => toNextJsHandler(getAuth());

export const GET = (req: Request) => handler().GET(req);
export const POST = (req: Request) => handler().POST(req);
