// Mise en forme compacte pour Claude : lignes et colonnes séparées par des tabulations,
// bien moins coûteuses en tokens que du JSON. Toutes les dates en heure de Paris.

const TZ = 'Europe/Paris';
const fmt = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

/** 1794564300 → « 2026-11-13 09:25 » (heure de Paris). */
export function formatTs(ts: number | null | undefined): string {
  if (!ts) return '';
  return fmt.format(new Date(ts * 1000)).replace(',', '');
}

/** Décalage de Paris par rapport à UTC à un instant donné, en minutes (60 l'hiver, 120 l'été). */
function parisOffsetMinutes(utcMs: number): number {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' })
    .formatToParts(new Date(utcMs))
    .find((p) => p.type === 'timeZoneName')?.value; // « GMT+01:00 »
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(part ?? '');
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/**
 * Lit une date donnée par Claude : « 2026-11-12 » (minuit à Paris), « 2026-11-12 14:30 » (heure de Paris),
 * ou une date ISO complète avec fuseau. Renvoie des secondes Unix.
 */
export function parseDate(input: string): number {
  const s = input.trim();
  const local = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(s);
  if (local) {
    const [, y, mo, d, h = '00', mi = '00'] = local;
    const asUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
    // Deux passes pour tomber juste les jours de changement d'heure.
    let utc = asUtc - parisOffsetMinutes(asUtc) * 60_000;
    utc = asUtc - parisOffsetMinutes(utc) * 60_000;
    return Math.floor(utc / 1000);
  }
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new Error(`date illisible : « ${input} » (attendu AAAA-MM-JJ ou AAAA-MM-JJ HH:MM)`);
  return Math.floor(ms / 1000);
}

/** Une cellule sur une seule ligne : pas de tabulation ni de retour à la ligne qui casserait le tableau. */
export function cell(v: unknown): string {
  return String(v ?? '')
    .replace(/[\t\r\n]+/g, ' ')
    .trim();
}

export function tsv(headers: string[], rows: unknown[][]): string {
  return [headers.join('\t'), ...rows.map((r) => r.map(cell).join('\t'))].join('\n');
}

export function duration(sec: number | null | undefined): string {
  if (!sec) return '';
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}
