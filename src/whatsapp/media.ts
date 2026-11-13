// Téléchargement d'un média (vocal, photo…) à la demande, depuis le message brut gardé en base.
// On ne stocke jamais les médias : on les retélécharge quand on en a besoin (piège n° 7).

import { downloadMediaMessage, normalizeMessageContent, type WAMessage, type WASocket } from '@whiskeysockets/baileys';

/** Tout média qui pointe ailleurs que chez WhatsApp est refusé (protection SSRF). */
export function isSafeMediaLocation(url?: string | null, directPath?: string | null): boolean {
  if (url != null) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    if (u.protocol !== 'https:') return false;
    if (u.hostname !== 'whatsapp.net' && !u.hostname.endsWith('.whatsapp.net')) return false;
    if (u.username || u.password || u.port) return false;
  }
  if (directPath != null) {
    if (!directPath.startsWith('/') || directPath.startsWith('//')) return false;
  }
  return url != null || directPath != null;
}

export interface Media {
  data: Buffer;
  mimetype: string;
}

/** Ce dont la pièce 3 et l'outil get_attachment ont besoin. Remplaçable par un faux dans les tests. */
export interface MediaFetcher {
  /** null si le média n'existe plus ou est refusé. */
  fetch(raw: WAMessage): Promise<Media | null>;
}

function mediaPart(raw: WAMessage) {
  const c = normalizeMessageContent(raw.message);
  return c?.audioMessage ?? c?.imageMessage ?? c?.videoMessage ?? c?.documentMessage ?? c?.stickerMessage ?? null;
}

export class BaileysMediaFetcher implements MediaFetcher {
  constructor(private readonly getSocket: () => WASocket | undefined) {}

  async fetch(raw: WAMessage): Promise<Media | null> {
    const part = mediaPart(raw);
    if (!part || !isSafeMediaLocation(part.url, part.directPath)) return null;
    const sock = this.getSocket();
    try {
      const data = await downloadMediaMessage(
        raw,
        'buffer',
        {},
        sock
          ? {
              // Fichier expiré chez WhatsApp : on demande au téléphone de le renvoyer.
              reuploadRequest: async (m) => {
                const fresh = await sock.updateMediaMessage(m);
                const p = mediaPart(fresh);
                if (!p || !isSafeMediaLocation(p.url, p.directPath)) throw new Error('média refusé');
                return fresh;
              },
              logger: sock.logger,
            }
          : undefined,
      );
      return { data, mimetype: part.mimetype ?? 'application/octet-stream' };
    } catch {
      return null;
    }
  }
}
