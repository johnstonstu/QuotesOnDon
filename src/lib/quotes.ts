/**
 * Build-time access to the versioned quote store.
 * Every consumer goes through here so the shape stays in one place.
 */
export type SourceType = 'primary' | 'secondary' | 'reference';
export type Confidence = 'primary' | 'secondary' | 'widely-reported' | 'disputed';
export type Status = 'published' | 'draft' | 'retracted';

export interface Source {
  label: string;
  url: string;
  type: SourceType;
  accessedAt?: string | null;
  excerpt?: string | null;
}

export interface Quote {
  id: string;
  text: string;
  speaker: string;
  spokenOn?: string | null;
  context?: string | null;
  tags: string[];
  sources: Source[];
  confidence: Confidence;
  status: Status;
  addedAt: string;
  addedBy: string;
  notes?: string | null;
}

const modules = import.meta.glob<{ default: Quote }>('../../data/quotes/*.json', { eager: true });

export const quotes: Quote[] = Object.values(modules)
  .map((m) => m.default)
  .filter((q) => q.status === 'published')
  .sort((a, b) => {
    const aDate = a.spokenOn ?? '';
    const bDate = b.spokenOn ?? '';
    if (aDate === bDate) return a.id.localeCompare(b.id);
    if (!aDate) return 1;
    if (!bDate) return -1;
    return bDate.localeCompare(aDate);
  });

export const totalQuotes = quotes.length;

export const confidenceLabel: Record<Confidence, string> = {
  primary: 'Primary source held',
  secondary: 'Secondary source',
  'widely-reported': 'Widely reported — no located primary source',
  disputed: 'Attribution disputed',
};

export function tagsWithCounts(): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>();
  for (const quote of quotes) {
    for (const tag of quote.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export function byTag(tag: string): Quote[] {
  return quotes.filter((q) => q.tags.includes(tag));
}

export function sourceHosts(): string[] {
  return [...new Set(quotes.flatMap((q) => q.sources.map((s) => new URL(s.url).hostname)))].sort();
}

export function confidenceCounts(): Record<Confidence, number> {
  const out: Record<Confidence, number> = { primary: 0, secondary: 0, 'widely-reported': 0, disputed: 0 };
  for (const q of quotes) out[q.confidence]++;
  return out;
}

/** Slim projection the browser fetches for the random/rotation and search UI. */
export function clientIndex() {
  return quotes.map((q) => ({
    id: q.id,
    text: q.text,
    speaker: q.speaker,
    spokenOn: q.spokenOn ?? null,
    context: q.context ?? null,
    tags: q.tags,
    confidence: q.confidence,
    source: q.sources[0] ? { label: q.sources[0].label, url: q.sources[0].url, type: q.sources[0].type } : null,
  }));
}

export function formatDate(value?: string | null): string | null {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}