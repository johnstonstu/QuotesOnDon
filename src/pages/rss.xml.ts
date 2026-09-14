import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { quotes } from '../lib/quotes';

export const prerender = true;

export function GET(context: APIContext) {
  return rss({
    title: 'Quotes on don',
    description: 'One wildly quoted man, with the receipt attached.',
    site: context.site ?? 'https://quotesondon.com',
    items: quotes.map((quote) => ({
      title: quote.text.length > 80 ? `${quote.text.slice(0, 80)}…` : quote.text,
      description: `${quote.text} — ${quote.speaker}${quote.context ? ` (${quote.context})` : ''}`,
      link: `/quotes/${quote.id}/`,
      pubDate: new Date(`${quote.spokenOn ?? quote.addedAt}T12:00:00Z`),
      categories: quote.tags,
    })),
    customData: '<language>en-ca</language>',
  });
}