import type { APIRoute } from 'astro';
import { clientIndex } from '../lib/quotes';

export const prerender = true;

export const GET: APIRoute = () =>
  new Response(JSON.stringify(clientIndex(), null, 0), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  });