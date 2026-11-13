// La base : un seul fichier SQLite sur le volume persistant.
// Elle range ce que lit la pièce 1 et répond aux questions des outils (pièce 4).

import { DatabaseSync } from 'node:sqlite';
import { BufferJSON } from '@whiskeysockets/baileys';
import type {
  ChatInfo,
  ContactInfo,
  IngestSink,
  LidMapping,
  MessageEdit,
  MessageRevoke,
  MessageType,
  StoredMessage,
} from '../whatsapp/types.js';

export type TranscriptStatus = 'pending' | 'done' | 'failed' | 'missing';

export interface MessageRow {
  chat_jid: string;
  id: string;
  sender_jid: string;
  from_me: number;
  ts: number;
  type: MessageType;
  body: string;
  push_name: string | null;
  duration_sec: number | null;
  edited_at: number | null;
  deleted_at: number | null;
  transcript: string | null;
  transcript_status: TranscriptStatus | null;
}

export interface ActiveChat {
  jid: string;
  name: string;
  isGroup: boolean;
  messages: number;
  lastTs: number;
  justinWrote: boolean;
  participants: number | null;
  /** Conversation retenue pour /flux : directe, petit groupe, groupe où Justin a écrit, ou groupe épinglé. */
  kept: boolean;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  chat_jid TEXT NOT NULL,
  id TEXT NOT NULL,
  sender_jid TEXT NOT NULL,
  from_me INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  push_name TEXT,
  duration_sec INTEGER,
  raw TEXT,
  edited_at INTEGER,
  deleted_at INTEGER,
  transcript TEXT,
  transcript_status TEXT,
  transcript_error TEXT,
  PRIMARY KEY (chat_jid, id)
);
CREATE INDEX IF NOT EXISTS messages_ts ON messages (ts);
CREATE INDEX IF NOT EXISTS messages_chat_ts ON messages (chat_jid, ts);
CREATE INDEX IF NOT EXISTS messages_transcript ON messages (transcript_status, ts);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  body, transcript, content='messages', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, body, transcript) VALUES (new.rowid, new.body, coalesce(new.transcript, ''));
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body, transcript) VALUES ('delete', old.rowid, old.body, coalesce(old.transcript, ''));
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body, transcript) VALUES ('delete', old.rowid, old.body, coalesce(old.transcript, ''));
  INSERT INTO messages_fts(rowid, body, transcript) VALUES (new.rowid, new.body, coalesce(new.transcript, ''));
END;

CREATE TABLE IF NOT EXISTS lid_map (lid TEXT PRIMARY KEY, pn TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS contacts (
  jid TEXT PRIMARY KEY,
  saved_name TEXT,
  push_name TEXT
);
CREATE TABLE IF NOT EXISTS chats (
  jid TEXT PRIMARY KEY,
  name TEXT,
  participants INTEGER,
  always_keep INTEGER NOT NULL DEFAULT 0
);
`;

/** Un nom masqué par WhatsApp, du type « +33∙∙∙08 », n'est pas un vrai nom. */
export const isMasked = (name?: string | null): boolean => !name || name.includes('∙');

/** « 33611111111@s.whatsapp.net » devient « +33611111111 ». */
export function phoneOf(jid: string): string | null {
  const m = /^(\d+)(?::\d+)?@s\.whatsapp\.net$/.exec(jid);
  return m ? `+${m[1]}` : null;
}

/** Chaque mot entre guillemets : FTS5 ne lit alors aucun caractère comme une commande. */
export function ftsQuery(text: string): string {
  return text
    .split(/\s+/)
    .map((w) => w.replace(/"/g, ''))
    .filter(Boolean)
    .map((w) => `"${w}"`)
    .join(' ');
}

export class Store implements IngestSink {
  readonly db: DatabaseSync;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ---------- Identités ----------

  /** Ramène un LID au numéro quand on le connaît ; sinon garde tel quel. */
  canonical(jid: string): string {
    if (!jid.endsWith('@lid')) return jid;
    const row = this.db.prepare('SELECT pn FROM lid_map WHERE lid = ?').get(jid) as { pn: string } | undefined;
    return row?.pn ?? jid;
  }

  saveLidMappings(mappings: LidMapping[]): void {
    this.tx(() => {
      const upsert = this.db.prepare(
        'INSERT INTO lid_map (lid, pn) VALUES (?, ?) ON CONFLICT(lid) DO UPDATE SET pn = excluded.pn',
      );
      for (const { lid, pn } of mappings) {
        upsert.run(lid, pn);
        this.regroup(lid, pn);
      }
    });
  }

  /** Re-range sous le numéro tout ce qui avait été stocké sous le LID (piège n° 2 du kit). */
  private regroup(lid: string, pn: string): void {
    // Conversation directe : on déplace les messages, sauf ceux déjà présents sous le numéro.
    this.db.prepare('UPDATE OR IGNORE messages SET chat_jid = ? WHERE chat_jid = ?').run(pn, lid);
    this.db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(lid);
    this.db.prepare('UPDATE messages SET sender_jid = ? WHERE sender_jid = ?').run(pn, lid);
    // Fiches : on fusionne en gardant ce qu'on sait déjà sous le numéro.
    const old = this.db.prepare('SELECT * FROM contacts WHERE jid = ?').get(lid) as
      | { saved_name: string | null; push_name: string | null }
      | undefined;
    if (old) {
      this.upsertContact(pn, old.saved_name, old.push_name);
      this.db.prepare('DELETE FROM contacts WHERE jid = ?').run(lid);
    }
    const oldChat = this.db.prepare('SELECT * FROM chats WHERE jid = ?').get(lid) as
      | { name: string | null; always_keep: number }
      | undefined;
    if (oldChat) {
      this.db
        .prepare(
          `INSERT INTO chats (jid, name, always_keep) VALUES (?, ?, ?)
           ON CONFLICT(jid) DO UPDATE SET name = coalesce(chats.name, excluded.name),
             always_keep = max(chats.always_keep, excluded.always_keep)`,
        )
        .run(pn, oldChat.name, oldChat.always_keep);
      this.db.prepare('DELETE FROM chats WHERE jid = ?').run(lid);
    }
  }

  private upsertContact(jid: string, saved: string | null | undefined, push: string | null | undefined): void {
    this.db
      .prepare(
        `INSERT INTO contacts (jid, saved_name, push_name) VALUES (?, ?, ?)
         ON CONFLICT(jid) DO UPDATE SET
           saved_name = coalesce(excluded.saved_name, contacts.saved_name),
           push_name = coalesce(excluded.push_name, contacts.push_name)`,
      )
      .run(jid, saved ?? null, push ?? null);
  }

  saveContacts(contacts: ContactInfo[]): void {
    this.tx(() => {
      for (const c of contacts) {
        if (c.lid && c.pn) this.db.prepare('INSERT OR REPLACE INTO lid_map (lid, pn) VALUES (?, ?)').run(c.lid, c.pn);
        this.upsertContact(this.canonical(c.pn ?? c.jid), c.savedName, c.pushName);
      }
    });
  }

  saveChats(chats: ChatInfo[]): void {
    this.tx(() => {
      const upsert = this.db.prepare(
        `INSERT INTO chats (jid, name) VALUES (?, ?)
         ON CONFLICT(jid) DO UPDATE SET name = coalesce(excluded.name, chats.name)`,
      );
      for (const c of chats) {
        const jid = this.canonical(c.pn ?? c.jid);
        upsert.run(jid, isMasked(c.name) ? null : (c.name ?? null));
      }
    });
  }

  setGroupParticipants(groupJid: string, count: number): void {
    this.db
      .prepare(
        `INSERT INTO chats (jid, participants) VALUES (?, ?)
         ON CONFLICT(jid) DO UPDATE SET participants = excluded.participants`,
      )
      .run(groupJid, count);
  }

  /** Groupes illiz à toujours retenir, quelle que soit leur taille (choisis par Justin à l'étape 5). */
  setAlwaysKeep(chatJid: string, keep: boolean): void {
    this.db
      .prepare(
        `INSERT INTO chats (jid, always_keep) VALUES (?, ?)
         ON CONFLICT(jid) DO UPDATE SET always_keep = excluded.always_keep`,
      )
      .run(chatJid, keep ? 1 : 0);
  }

  /** Nom affiché (piège n° 6) : carnet, puis libellé non masqué, puis nom de profil, puis numéro. */
  displayName(jid: string): string {
    if (jid === 'me') return 'Justin';
    const c = this.canonical(jid);
    const contact = this.db.prepare('SELECT saved_name, push_name FROM contacts WHERE jid = ?').get(c) as
      | { saved_name: string | null; push_name: string | null }
      | undefined;
    if (contact?.saved_name && !isMasked(contact.saved_name)) return contact.saved_name;
    const chat = this.db.prepare('SELECT name FROM chats WHERE jid = ?').get(c) as { name: string | null } | undefined;
    if (chat?.name && !isMasked(chat.name)) return chat.name;
    if (contact?.push_name && !isMasked(contact.push_name)) return contact.push_name;
    const lastPush = this.db
      .prepare('SELECT push_name FROM messages WHERE sender_jid = ? AND push_name IS NOT NULL ORDER BY ts DESC LIMIT 1')
      .get(c) as { push_name: string } | undefined;
    if (lastPush && !isMasked(lastPush.push_name)) return lastPush.push_name;
    return phoneOf(c) ?? c;
  }

  // ---------- Messages ----------

  saveMessages(messages: StoredMessage[]): void {
    this.tx(() => {
      const upsert = this.db.prepare(
        `INSERT INTO messages (chat_jid, id, sender_jid, from_me, ts, type, body, push_name, duration_sec, raw, transcript_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(chat_jid, id) DO UPDATE SET
           ts = excluded.ts,
           push_name = coalesce(excluded.push_name, messages.push_name),
           raw = excluded.raw,
           body = CASE WHEN messages.edited_at IS NULL AND messages.deleted_at IS NULL THEN excluded.body ELSE messages.body END`,
      );
      for (const m of messages) {
        const chat = this.canonical(m.chatJid);
        const sender =
          m.senderJid === 'me'
            ? 'me'
            : m.senderAltJid?.endsWith('@s.whatsapp.net')
              ? m.senderAltJid
              : this.canonical(m.senderJid);
        if (m.senderAltJid && m.senderJid.endsWith('@lid') && m.senderAltJid.endsWith('@s.whatsapp.net')) {
          this.db.prepare('INSERT OR IGNORE INTO lid_map (lid, pn) VALUES (?, ?)').run(m.senderJid, m.senderAltJid);
        }
        upsert.run(
          chat,
          m.id,
          sender,
          m.fromMe ? 1 : 0,
          m.timestamp,
          m.type,
          m.body,
          m.pushName ?? null,
          m.durationSec ?? null,
          JSON.stringify(m.raw, BufferJSON.replacer),
          m.type === 'voice' ? 'pending' : null,
        );
      }
    });
  }

  private target(chatJid: string, id: string): { sender_jid: string } | undefined {
    return this.db
      .prepare('SELECT sender_jid FROM messages WHERE chat_jid = ? AND id = ?')
      .get(this.canonical(chatJid), id) as { sender_jid: string } | undefined;
  }

  /** Vrai si l'auteur de la modification est bien l'auteur du message visé. */
  private sameAuthor(targetSender: string, author: string): boolean {
    return targetSender === (author === 'me' ? 'me' : this.canonical(author));
  }

  applyEdit(e: MessageEdit): void {
    const t = this.target(e.chatJid, e.targetId);
    if (!t || !this.sameAuthor(t.sender_jid, e.authorJid)) return;
    this.db
      .prepare('UPDATE messages SET body = ?, edited_at = ? WHERE chat_jid = ? AND id = ?')
      .run(e.newBody, e.editedAt, this.canonical(e.chatJid), e.targetId);
  }

  /** Un message supprimé pour tous : on efface son contenu, on garde la trace qu'il a existé. */
  applyRevoke(r: MessageRevoke): void {
    const t = this.target(r.chatJid, r.targetId);
    if (!t || !this.sameAuthor(t.sender_jid, r.authorJid)) return;
    this.db
      .prepare(
        `UPDATE messages SET body = '', transcript = NULL, raw = NULL, deleted_at = ?,
           transcript_status = CASE WHEN transcript_status IS NULL THEN NULL ELSE 'missing' END
         WHERE chat_jid = ? AND id = ?`,
      )
      .run(r.revokedAt, this.canonical(r.chatJid), r.targetId);
  }

  getRaw(chatJid: string, id: string): unknown {
    const row = this.db
      .prepare('SELECT raw FROM messages WHERE chat_jid = ? AND id = ?')
      .get(this.canonical(chatJid), id) as { raw: string | null } | undefined;
    return row?.raw ? JSON.parse(row.raw, BufferJSON.reviver) : undefined;
  }

  findMessage(id: string, chatJid?: string): MessageRow | undefined {
    const sql = chatJid
      ? 'SELECT * FROM messages WHERE id = ? AND chat_jid = ?'
      : 'SELECT * FROM messages WHERE id = ? ORDER BY ts DESC LIMIT 1';
    const args = chatJid ? [id, this.canonical(chatJid)] : [id];
    return this.db.prepare(sql).get(...args) as MessageRow | undefined;
  }

  // ---------- Questions des outils ----------

  status(): { messages: number; chats: number; lastTs: number | null; voicePending: number; voiceFailed: number } {
    const q = (sql: string) => (this.db.prepare(sql).get() as { n: number | null }).n;
    return {
      messages: q('SELECT count(*) AS n FROM messages') ?? 0,
      chats: q('SELECT count(DISTINCT chat_jid) AS n FROM messages') ?? 0,
      lastTs: q('SELECT max(ts) AS n FROM messages'),
      voicePending: q("SELECT count(*) AS n FROM messages WHERE transcript_status = 'pending'") ?? 0,
      voiceFailed: q("SELECT count(*) AS n FROM messages WHERE transcript_status = 'failed'") ?? 0,
    };
  }

  listActiveChats(since: number, until = Number.MAX_SAFE_INTEGER, maxGroup = 10): ActiveChat[] {
    const rows = this.db
      .prepare(
        `SELECT m.chat_jid AS jid, count(*) AS n, max(m.ts) AS last, max(m.from_me) AS wrote,
                count(DISTINCT m.sender_jid) AS senders, c.participants, coalesce(c.always_keep, 0) AS keep
         FROM messages m LEFT JOIN chats c ON c.jid = m.chat_jid
         WHERE m.ts >= ? AND m.ts < ?
         GROUP BY m.chat_jid ORDER BY last DESC`,
      )
      .all(since, until) as {
      jid: string;
      n: number;
      last: number;
      wrote: number;
      senders: number;
      participants: number | null;
      keep: number;
    }[];
    return rows.map((r) => {
      const isGroup = r.jid.endsWith('@g.us');
      // Taille inconnue : on se rabat sur le nombre de personnes qui ont écrit.
      const size = r.participants ?? r.senders;
      return {
        jid: r.jid,
        name: this.displayName(r.jid),
        isGroup,
        messages: r.n,
        lastTs: r.last,
        justinWrote: r.wrote === 1,
        participants: r.participants,
        kept: !isGroup || r.keep === 1 || r.wrote === 1 || size <= maxGroup,
      };
    });
  }

  /** Conversations par nom ou numéro, plus les groupes où la personne a écrit. */
  searchChats(query: string): { jid: string; name: string; isGroup: boolean; via?: string }[] {
    const q = query.trim().toLowerCase();
    // Numéro écrit à la française (06…) ou avec 00 : on le met au format de WhatsApp (336…).
    const digits = q
      .replace(/\D/g, '')
      .replace(/^00/, '')
      .replace(/^0(?=\d)/, '33');
    const all = this.db
      .prepare(
        `SELECT jid FROM chats UNION SELECT DISTINCT chat_jid FROM messages
         UNION SELECT jid FROM contacts`,
      )
      .all() as { jid: string }[];
    const strip = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
    const matches = all
      .map(({ jid }) => ({ jid, name: this.displayName(jid), isGroup: jid.endsWith('@g.us') }))
      .filter(
        (c) => strip(c.name).includes(strip(q)) || (digits.length >= 4 && c.jid.replace(/\D/g, '').includes(digits)),
      );
    const people = matches.filter((m) => !m.isGroup).map((m) => m.jid);
    const shared = people.length
      ? (this.db
          .prepare(
            `SELECT DISTINCT chat_jid AS jid, sender_jid AS via FROM messages
             WHERE chat_jid LIKE '%@g.us' AND sender_jid IN (${people.map(() => '?').join(',')})`,
          )
          .all(...people) as { jid: string; via: string }[])
      : [];
    const seen = new Set(matches.map((m) => m.jid));
    return [
      ...matches,
      ...shared
        .filter((s) => !seen.has(s.jid))
        .map((s) => ({ jid: s.jid, name: this.displayName(s.jid), isGroup: true, via: this.displayName(s.via) })),
    ];
  }

  exportChat(chatJid: string, since = 0, until = Number.MAX_SAFE_INTEGER): MessageRow[] {
    return this.db
      .prepare('SELECT * FROM messages WHERE chat_jid = ? AND ts >= ? AND ts < ? ORDER BY ts, id')
      .all(this.canonical(chatJid), since, until) as unknown as MessageRow[];
  }

  searchMessages(query: string, since = 0, chatJid?: string, limit = 50): MessageRow[] {
    const match = ftsQuery(query);
    if (!match) return [];
    const args: (string | number)[] = [match, since];
    let sql = `SELECT m.* FROM messages_fts f JOIN messages m ON m.rowid = f.rowid
               WHERE messages_fts MATCH ? AND m.ts >= ? AND m.deleted_at IS NULL`;
    if (chatJid) {
      sql += ' AND m.chat_jid = ?';
      args.push(this.canonical(chatJid));
    }
    sql += ' ORDER BY m.ts DESC LIMIT ?';
    args.push(limit);
    return this.db.prepare(sql).all(...args) as unknown as MessageRow[];
  }
}
