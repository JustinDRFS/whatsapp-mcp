// Transforme un message brut de Baileys en événement simple pour la base.
// Fonctions pures : aucune connexion, testables avec de faux messages.

import { getContentType, normalizeMessageContent, proto, type WAMessage } from '@whiskeysockets/baileys';
import type { MessageType, NormalizedEvent, StoredMessage } from './types.js';

type LongLike = number | { toNumber(): number } | null | undefined;

export function toSeconds(t: LongLike): number {
  if (t == null) return 0;
  return typeof t === 'number' ? t : t.toNumber();
}

/** Conversations qu'on ignore : statuts, chaînes, diffusions. */
export function isIgnoredChat(jid: string | null | undefined): boolean {
  if (!jid) return true;
  return jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@broadcast');
}

/** Auteur d'un message : 'me', le participant (groupe) ou la conversation (direct). */
export function authorOf(key: WAMessage['key']): { jid: string; alt?: string } {
  if (key.fromMe) return { jid: 'me' };
  const isGroup = key.remoteJid?.endsWith('@g.us');
  if (isGroup) return { jid: key.participant ?? 'unknown', alt: key.participantAlt ?? undefined };
  return { jid: key.remoteJid ?? 'unknown', alt: key.remoteJidAlt ?? undefined };
}

function describe(content: proto.IMessage): { type: MessageType; body: string; durationSec?: number } | null {
  const kind = getContentType(content);
  switch (kind) {
    case 'conversation':
      return { type: 'text', body: content.conversation ?? '' };
    case 'extendedTextMessage':
      return { type: 'text', body: content.extendedTextMessage?.text ?? '' };
    case 'audioMessage': {
      const a = content.audioMessage!;
      return { type: a.ptt ? 'voice' : 'audio', body: '', durationSec: a.seconds ?? undefined };
    }
    case 'imageMessage':
      return { type: 'image', body: content.imageMessage?.caption ?? '' };
    case 'videoMessage':
      return { type: 'video', body: content.videoMessage?.caption ?? '' };
    case 'documentMessage': {
      const d = content.documentMessage!;
      return { type: 'document', body: [d.fileName, d.caption].filter(Boolean).join(' : ') };
    }
    case 'documentWithCaptionMessage': {
      const d = content.documentWithCaptionMessage?.message?.documentMessage;
      return { type: 'document', body: [d?.fileName, d?.caption].filter(Boolean).join(' : ') };
    }
    case 'stickerMessage':
      return { type: 'sticker', body: '' };
    case 'locationMessage':
    case 'liveLocationMessage': {
      const l = content.locationMessage ?? content.liveLocationMessage;
      const name = (l as proto.Message.ILocationMessage | undefined)?.name;
      return { type: 'location', body: name ?? `${l?.degreesLatitude}, ${l?.degreesLongitude}` };
    }
    case 'contactMessage':
      return { type: 'contact', body: content.contactMessage?.displayName ?? '' };
    case 'contactsArrayMessage':
      return { type: 'contact', body: content.contactsArrayMessage?.displayName ?? '' };
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3': {
      const p = content.pollCreationMessage ?? content.pollCreationMessageV2 ?? content.pollCreationMessageV3;
      const options = (p?.options ?? []).map((o) => o.optionName).join(' / ');
      return { type: 'poll', body: `${p?.name ?? ''} (${options})` };
    }
    default:
      return null; // réactions, accusés, messages système : ignorés
  }
}

function textOf(content: proto.IMessage | null | undefined): string {
  const c = normalizeMessageContent(content);
  if (!c) return '';
  const d = describe(c);
  return d?.body ?? '';
}

/** Un message brut devient : un message, une modification, une suppression, ou rien. */
export function normalizeMessage(msg: WAMessage): NormalizedEvent | null {
  const key = msg.key;
  const chatJid = key?.remoteJid;
  if (!key?.id || !chatJid || isIgnoredChat(chatJid)) return null;

  const content = normalizeMessageContent(msg.message);
  if (!content) return null;
  const author = authorOf(key);
  const timestamp = toSeconds(msg.messageTimestamp as LongLike);

  const protocol = content.protocolMessage;
  if (protocol) {
    const targetId = protocol.key?.id;
    if (!targetId) return null;
    if (protocol.type === proto.Message.ProtocolMessage.Type.REVOKE) {
      return { kind: 'revoke', revoke: { chatJid, targetId, authorJid: author.jid, revokedAt: timestamp } };
    }
    if (protocol.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT) {
      return {
        kind: 'edit',
        edit: { chatJid, targetId, authorJid: author.jid, newBody: textOf(protocol.editedMessage), editedAt: timestamp },
      };
    }
    return null;
  }

  const d = describe(content);
  if (!d) return null;

  const message: StoredMessage = {
    id: key.id,
    chatJid,
    senderJid: author.jid,
    senderAltJid: author.alt,
    fromMe: Boolean(key.fromMe),
    timestamp,
    type: d.type,
    body: d.body,
    pushName: msg.pushName ?? undefined,
    durationSec: d.durationSec,
    raw: msg,
  };
  return { kind: 'message', message };
}
