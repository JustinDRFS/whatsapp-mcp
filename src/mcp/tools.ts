// Les outils MCP : tous en lecture seule côté WhatsApp.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WAMessage } from '@whiskeysockets/baileys';
import { z } from 'zod';
import { duration, formatTs, parseDate, tsv } from '../format.js';
import type { MessageRow, Store } from '../store/store.js';
import { CREDIT_ALERT, type VoiceQueue } from '../voice/queue.js';
import type { ConnectionState } from '../whatsapp/connection.js';
import type { MediaFetcher } from '../whatsapp/media.js';

export interface ToolDeps {
  store: Store;
  /** Absent tant qu'aucune clé OpenAI n'est configurée. */
  voices?: VoiceQueue;
  media: MediaFetcher;
  connection: () => ConnectionState;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

/** Le corps d'un message tel que Claude le lit. */
export function renderBody(r: MessageRow): string {
  if (r.deleted_at) return '[message supprimé]';
  const edited = r.edited_at ? ' (modifié)' : '';
  switch (r.type) {
    case 'text':
      return r.body + edited;
    case 'voice': {
      const d = duration(r.duration_sec);
      if (r.transcript_status === 'done') return `[vocal ${d}] ${r.transcript ?? ''}`;
      const why = { pending: 'pas encore transcrit', failed: 'transcription en échec', missing: 'fichier introuvable' }[
        r.transcript_status ?? 'pending'
      ];
      return `[vocal ${d}, ${why}]`;
    }
    default: {
      const label = {
        audio: 'audio',
        image: 'photo',
        video: 'vidéo',
        document: 'document',
        sticker: 'sticker',
        location: 'lieu',
        contact: 'contact',
        poll: 'sondage',
        other: 'autre',
      }[r.type];
      return `[${label}]${r.body ? ` ${r.body}` : ''}${edited}`;
    }
  }
}

function since(input: string | undefined, fallback: number): number {
  return input ? parseDate(input) : fallback;
}

export function buildServer(deps: ToolDeps): McpServer {
  const { store } = deps;
  const server = new McpServer({ name: 'whatsapp-justin', version: '1.0.0' });
  const author = (r: MessageRow) => store.displayName(r.from_me ? 'me' : r.sender_jid);

  server.registerTool(
    'status',
    {
      description:
        "État du service WhatsApp : session, volumes, dernier message, vocaux en attente, alertes. À lire en premier : si la session est tombée, le signaler en tête de la synthèse.",
      annotations: READ_ONLY,
    },
    async () => {
      const c = deps.connection();
      const s = store.status();
      const alerts: string[] = [];
      if (c.status !== 'open') alerts.push(`SESSION WHATSAPP NON CONNECTÉE (${c.status}) : rescanner le QR sur /admin`);
      if (store.getMeta(CREDIT_ALERT)) alerts.push('CRÉDIT OPENAI ÉPUISÉ : vocaux en pause');
      if (!deps.voices) alerts.push('transcription désactivée (pas de clé OpenAI)');
      const lines = [
        ...alerts.map((a) => `ALERTE\t${a}`),
        `session\t${c.status}`,
        `connectée depuis\t${formatTs(c.lastOpenAt)}`,
        `messages\t${s.messages}`,
        `conversations\t${s.chats}`,
        `dernier message\t${formatTs(s.lastTs)}`,
        `vocaux en attente\t${s.voicePending}`,
        `vocaux en échec\t${s.voiceFailed}`,
      ];
      return text(lines.join('\n'));
    },
  );

  server.registerTool(
    'list_active_chats',
    {
      description:
        "Conversations actives sur une période (dates AAAA-MM-JJ, heure de Paris). La colonne retenue vaut oui pour les conversations directes, les petits groupes (≤ max_group personnes), les groupes où Justin a écrit et les groupes épinglés.",
      inputSchema: {
        since: z.string().describe('début, ex. 2026-11-12 ou 2026-11-12 18:00'),
        until: z.string().optional().describe('fin exclue ; par défaut maintenant'),
        max_group: z.number().int().min(1).max(1000).default(10),
      },
      annotations: READ_ONLY,
    },
    async ({ since: s, until, max_group }) => {
      const chats = store.listActiveChats(parseDate(s), until ? parseDate(until) : undefined, max_group);
      if (!chats.length) return text('Aucune conversation active sur la période.');
      return text(
        tsv(
          ['chat_jid', 'nom', 'type', 'messages', 'dernier', 'justin_a_ecrit', 'retenue'],
          chats.map((c) => [
            c.jid,
            c.name,
            c.isGroup ? `groupe${c.participants ? ` (${c.participants})` : ''}` : 'direct',
            c.messages,
            formatTs(c.lastTs),
            c.justinWrote ? 'oui' : 'non',
            c.kept ? 'oui' : 'non',
          ]),
        ),
      );
    },
  );

  server.registerTool(
    'search_chats',
    {
      description:
        "Trouve une conversation par nom (sans accents) ou numéro (06… accepté), plus les groupes que Justin partage avec la personne.",
      inputSchema: { query: z.string().min(1) },
      annotations: READ_ONLY,
    },
    async ({ query }) => {
      const r = store.searchChats(query);
      if (!r.length) return text(`Aucune conversation pour « ${query} ».`);
      return text(
        tsv(
          ['chat_jid', 'nom', 'type', 'via'],
          r.map((c) => [c.jid, c.name, c.isGroup ? 'groupe' : 'direct', c.via ?? '']),
        ),
      );
    },
  );

  server.registerTool(
    'export_chat',
    {
      description:
        "Messages d'une conversation, au format date | auteur | corps, dans l'ordre. Transcrit d'abord jusqu'à transcribe_max vocaux de la période qui ne l'étaient pas.",
      inputSchema: {
        chat_jid: z.string(),
        since: z.string().optional(),
        until: z.string().optional(),
        transcribe_max: z.number().int().min(0).max(50).default(10),
      },
      annotations: READ_ONLY,
    },
    async ({ chat_jid, since: s, until, transcribe_max }) => {
      const from = since(s, 0);
      const to = until ? parseDate(until) : undefined;
      if (deps.voices && transcribe_max > 0) {
        await deps.voices.run({ chatJid: chat_jid, since: from, limit: transcribe_max });
      }
      const rows = store.exportChat(chat_jid, from, to);
      if (!rows.length) return text('Aucun message sur la période.');
      const head = `${store.displayName(chat_jid)} (${rows.length} messages)`;
      return text([head, ...rows.map((r) => `${formatTs(r.ts)} | ${author(r)} | ${renderBody(r)}`)].join('\n'));
    },
  );

  server.registerTool(
    'search_messages',
    {
      description:
        'Recherche plein texte dans les messages et les vocaux transcrits, sans tenir compte des accents. Résultats du plus récent au plus ancien.',
      inputSchema: {
        query: z.string().min(1),
        since: z.string().optional(),
        chat_jid: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(50),
      },
      annotations: READ_ONLY,
    },
    async ({ query, since: s, chat_jid, limit }) => {
      const rows = store.searchMessages(query, since(s, 0), chat_jid, limit);
      if (!rows.length) return text(`Aucun message pour « ${query} ».`);
      return text(
        tsv(
          ['date', 'conversation', 'auteur', 'corps', 'message_id', 'chat_jid'],
          rows.map((r) => [formatTs(r.ts), store.displayName(r.chat_jid), author(r), renderBody(r), r.id, r.chat_jid]),
        ),
      );
    },
  );

  server.registerTool(
    'transcribe_voice_notes',
    {
      description:
        "Transcrit les vocaux en attente, un par un (les plus récents d'abord). retry_failed relance aussi ceux en échec.",
      inputSchema: {
        chat_jid: z.string().optional(),
        since: z.string().optional(),
        limit: z.number().int().min(1).max(50).default(10),
        retry_failed: z.boolean().default(false),
      },
      annotations: READ_ONLY,
    },
    async ({ chat_jid, since: s, limit, retry_failed }) => {
      if (!deps.voices) return text('Transcription désactivée : aucune clé OpenAI configurée.');
      const r = await deps.voices.run({ chatJid: chat_jid, since: since(s, 0), limit, retryFailed: retry_failed });
      const lines = [`transcrits\t${r.done}`, `en échec\t${r.failed}`, `introuvables\t${r.missing}`];
      if (r.outOfCredit) lines.unshift('ALERTE\tcrédit OpenAI épuisé : arrêt, les vocaux restants sont gardés en attente');
      return text(lines.join('\n'));
    },
  );

  server.registerTool(
    'get_attachment',
    {
      description: "Média d'un message (photo, document…), retéléchargé à la demande chez WhatsApp. 10 Mo au plus.",
      inputSchema: { message_id: z.string(), chat_jid: z.string().optional() },
      annotations: READ_ONLY,
    },
    async ({ message_id, chat_jid }) => {
      const row = store.findMessage(message_id, chat_jid);
      if (!row) return text('Message introuvable.');
      const raw = store.getRaw(row.chat_jid, row.id) as WAMessage | undefined;
      const media = raw ? await deps.media.fetch(raw) : null;
      if (!media) return text('Média introuvable (supprimé, expiré ou refusé).');
      if (media.data.length > MAX_ATTACHMENT_BYTES) return text(`Média trop lourd (${Math.round(media.data.length / 1e6)} Mo).`);
      const mimeType = media.mimetype.split(';')[0];
      const data = media.data.toString('base64');
      if (mimeType.startsWith('image/')) return { content: [{ type: 'image' as const, data, mimeType }] };
      return {
        content: [
          {
            type: 'resource' as const,
            resource: { uri: `whatsapp://${row.chat_jid}/${row.id}`, mimeType, blob: data },
          },
        ],
      };
    },
  );

  return server;
}
