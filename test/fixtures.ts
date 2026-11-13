// Faux messages au format Baileys, pour tester sans connexion.

import { proto, type WAMessage } from '@whiskeysockets/baileys';
import type { ChatInfo, ContactInfo, IngestSink, LidMapping, MessageEdit, MessageRevoke, StoredMessage } from '../src/whatsapp/types.js';

export const CHARLOTTE_PN = '33611111111@s.whatsapp.net';
export const CHARLOTTE_LID = '111111111111111@lid';
export const GROUPE_ILLIZ = '120363000000000001@g.us';

let n = 0;
export function msg(partial: { key?: Partial<WAMessage['key']>; message?: proto.IMessage; ts?: number; pushName?: string }): WAMessage {
  n += 1;
  return {
    key: { remoteJid: CHARLOTTE_PN, fromMe: false, id: `MSG${n}`, ...partial.key },
    message: partial.message,
    messageTimestamp: partial.ts ?? 1_794_500_000,
    pushName: partial.pushName,
  } as WAMessage;
}

export class MemorySink implements IngestSink {
  messages: StoredMessage[] = [];
  edits: MessageEdit[] = [];
  revokes: MessageRevoke[] = [];
  mappings: LidMapping[] = [];
  contacts: ContactInfo[] = [];
  chats: ChatInfo[] = [];
  calls: string[] = [];
  saveMessages(m: StoredMessage[]) {
    this.calls.push('messages');
    this.messages.push(...m);
  }
  applyEdit(e: MessageEdit) {
    this.edits.push(e);
  }
  applyRevoke(r: MessageRevoke) {
    this.revokes.push(r);
  }
  saveLidMappings(m: LidMapping[]) {
    this.calls.push('mappings');
    this.mappings.push(...m);
  }
  saveContacts(c: ContactInfo[]) {
    this.contacts.push(...c);
  }
  saveChats(c: ChatInfo[]) {
    this.chats.push(...c);
  }
}

/** Émetteur minimal, comme sock.ev. */
export class FakeEmitter {
  private handlers = new Map<string, ((arg: any) => void)[]>();
  on(event: string, fn: (arg: any) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
  }
  emit(event: string, arg: unknown) {
    for (const fn of this.handlers.get(event) ?? []) fn(arg);
  }
}
