// Branche les événements Baileys sur la base (IngestSink).
// Les événements ne sont que des données : on les teste avec un faux émetteur, sans connexion.

import type { BaileysEventMap, Chat, Contact, WAMessage } from '@whiskeysockets/baileys';
import { normalizeMessage } from './normalize.js';
import type { ChatInfo, ContactInfo, IngestSink, LidMapping, StoredMessage } from './types.js';

export interface EventSource {
  on<K extends keyof BaileysEventMap>(event: K, listener: (arg: BaileysEventMap[K]) => void): void;
}

/** Journal sans contenu de message : seulement des compteurs et des noms d'événements. */
export type Log = (msg: string) => void;

const isLid = (jid?: string | null): jid is string => Boolean(jid?.endsWith('@lid'));
const isPn = (jid?: string | null): jid is string => Boolean(jid?.endsWith('@s.whatsapp.net'));

/** Un couple LID ↔ numéro, dans n'importe quel ordre, ou rien. */
export function pairOf(a?: string | null, b?: string | null): LidMapping | null {
  if (isLid(a) && isPn(b)) return { lid: a, pn: b };
  if (isPn(a) && isLid(b)) return { lid: b, pn: a };
  return null;
}

export function mappingsFromMessage(msg: WAMessage): LidMapping[] {
  const k = msg.key ?? {};
  return [pairOf(k.remoteJid, k.remoteJidAlt), pairOf(k.participant, k.participantAlt)].filter(
    (m): m is LidMapping => m !== null,
  );
}

export function contactInfo(c: Partial<Contact>): ContactInfo | null {
  if (!c.id) return null;
  return {
    jid: c.id,
    lid: c.lid ?? (isLid(c.id) ? c.id : undefined),
    pn: c.phoneNumber ?? (isPn(c.id) ? c.id : undefined),
    savedName: c.name ?? undefined,
    pushName: c.notify ?? undefined,
  };
}

export function chatInfo(c: Partial<Chat>): ChatInfo | null {
  if (!c.id) return null;
  return {
    jid: c.id,
    name: c.name ?? c.displayName ?? undefined,
    lid: c.lidJid ?? (isLid(c.id) ? c.id : undefined),
    pn: c.pnJid ?? (isPn(c.id) ? c.id : undefined),
  };
}

function mappingsFromContacts(contacts: ContactInfo[]): LidMapping[] {
  return contacts.flatMap((c) => (c.lid && c.pn ? [{ lid: c.lid, pn: c.pn }] : []));
}

export function ingestMessages(sink: IngestSink, messages: WAMessage[]): number {
  const stored: StoredMessage[] = [];
  const mappings: LidMapping[] = [];
  for (const m of messages) {
    mappings.push(...mappingsFromMessage(m));
    const ev = normalizeMessage(m);
    if (!ev) continue;
    if (ev.kind === 'message') stored.push(ev.message);
    else if (ev.kind === 'edit') sink.applyEdit(ev.edit);
    else sink.applyRevoke(ev.revoke);
  }
  // Les correspondances d'abord : la base peut alors ranger les messages sous le numéro.
  if (mappings.length) sink.saveLidMappings(mappings);
  if (stored.length) sink.saveMessages(stored);
  return stored.length;
}

export function attachIngest(ev: EventSource, sink: IngestSink, log: Log = () => {}): void {
  const safe =
    <T>(name: string, fn: (arg: T) => void) =>
    (arg: T) => {
      try {
        fn(arg);
      } catch (err) {
        log(`ingest ${name} : échec (${(err as Error).name})`);
      }
    };

  ev.on(
    'messages.upsert',
    safe('messages.upsert', ({ messages }) => {
      ingestMessages(sink, messages);
    }),
  );

  ev.on(
    'messages.update',
    safe('messages.update', (updates) => {
      // Certaines modifications arrivent ici plutôt que dans messages.upsert.
      const asMessages = updates
        .filter((u) => u.update?.message)
        .map((u) => ({ key: u.key, message: u.update.message, messageTimestamp: u.update.messageTimestamp }) as WAMessage);
      if (asMessages.length) ingestMessages(sink, asMessages);
    }),
  );

  ev.on(
    'messaging-history.set',
    safe('messaging-history.set', ({ chats, contacts, messages, lidPnMappings }) => {
      if (lidPnMappings?.length) sink.saveLidMappings(lidPnMappings);
      const cs = contacts.map(contactInfo).filter((c): c is ContactInfo => c !== null);
      const chs = chats.map(chatInfo).filter((c): c is ChatInfo => c !== null);
      const fromChats = chs.flatMap((c) => (c.lid && c.pn ? [{ lid: c.lid, pn: c.pn }] : []));
      const mappings = [...mappingsFromContacts(cs), ...fromChats];
      if (mappings.length) sink.saveLidMappings(mappings);
      if (cs.length) sink.saveContacts(cs);
      if (chs.length) sink.saveChats(chs);
      const n = ingestMessages(sink, messages);
      log(`historique : ${chs.length} conversations, ${cs.length} contacts, ${n} messages`);
    }),
  );

  ev.on(
    'lid-mapping.update',
    safe('lid-mapping.update', (m) => {
      sink.saveLidMappings([m]);
    }),
  );

  const onContacts = safe('contacts', (contacts: Partial<Contact>[]) => {
    const cs = contacts.map(contactInfo).filter((c): c is ContactInfo => c !== null);
    const mappings = mappingsFromContacts(cs);
    if (mappings.length) sink.saveLidMappings(mappings);
    if (cs.length) sink.saveContacts(cs);
  });
  ev.on('contacts.upsert', onContacts);
  ev.on('contacts.update', onContacts);

  ev.on(
    'chats.upsert',
    safe('chats.upsert', (chats) => {
      const chs = chats.map(chatInfo).filter((c): c is ChatInfo => c !== null);
      if (chs.length) sink.saveChats(chs);
    }),
  );

  ev.on(
    'group-participants.update',
    safe('group-participants.update', ({ participants }) => {
      const mappings = participants
        .map((p) => pairOf(p.lid ?? p.id, p.phoneNumber) ?? pairOf(p.id, p.phoneNumber))
        .filter((m): m is LidMapping => m !== null);
      if (mappings.length) sink.saveLidMappings(mappings);
    }),
  );
}
