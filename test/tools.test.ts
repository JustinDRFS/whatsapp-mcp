import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { formatTs, parseDate } from '../src/format.js';
import { createApp } from '../src/http/app.js';
import { buildServer, type ToolDeps } from '../src/mcp/tools.js';
import { Store } from '../src/store/store.js';
import { VoiceQueue } from '../src/voice/queue.js';
import type { ConnectionState } from '../src/whatsapp/connection.js';
import type { MediaFetcher } from '../src/whatsapp/media.js';
import type { StoredMessage } from '../src/whatsapp/types.js';
import { CHARLOTTE_PN, GROUPE_ILLIZ } from './fixtures.js';

const T = parseDate('2026-11-12 18:30');
const TOKEN = 'a'.repeat(64);

function m(p: Partial<StoredMessage> & { id: string }): StoredMessage {
  return { chatJid: CHARLOTTE_PN, senderJid: CHARLOTTE_PN, fromMe: false, timestamp: T, type: 'text', body: '', raw: { key: { id: p.id } }, ...p };
}

let store: Store;
let deps: ToolDeps;
let state: ConnectionState;
const fetcher: MediaFetcher = { fetch: async () => ({ data: Buffer.from('png'), mimetype: 'image/png' }) };

beforeEach(() => {
  store = new Store(':memory:');
  state = { status: 'open', reconnectAttempts: 0, lastOpenAt: T };
  store.saveContacts([{ jid: CHARLOTTE_PN, savedName: 'Charlotte Dillies' }]);
  store.saveChats([{ jid: GROUPE_ILLIZ, name: 'Équipe illiz' }]);
  store.saveMessages([
    m({ id: 'A', body: 'Le mandat est signé' }),
    m({ id: 'B', senderJid: 'me', fromMe: true, body: 'Top, merci !', timestamp: T + 60 }),
    m({ id: 'V', type: 'voice', durationSec: 42, timestamp: T + 120 }),
    m({ id: 'I', type: 'image', body: 'La façade', timestamp: T + 180 }),
    m({ id: 'G', chatJid: GROUPE_ILLIZ, body: 'Réunion lundi', timestamp: T + 240 }),
  ]);
  const voices = new VoiceQueue(store, fetcher, { transcribe: async () => 'On visite samedi à dix heures' });
  deps = { store, voices, media: fetcher, connection: () => state };
});

async function call(name: string, args: Record<string, unknown> = {}) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([buildServer(deps).connect(a), client.connect(b)]);
  const r = await client.callTool({ name, arguments: args });
  await client.close();
  return r as { content: { type: string; text?: string; mimeType?: string; data?: string }[] };
}
const textOf = async (name: string, args?: Record<string, unknown>) => (await call(name, args)).content[0].text ?? '';

describe('outils MCP', () => {
  it('déclare les 7 outils, tous en lecture seule', async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' });
    await Promise.all([buildServer(deps).connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'export_chat', 'get_attachment', 'list_active_chats', 'search_chats', 'search_messages', 'status', 'transcribe_voice_notes',
    ]);
    expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
  });

  it('status signale une session tombée en tête (piège n° 5)', async () => {
    expect(await textOf('status')).toMatch(/^session\topen/m);
    state = { status: 'logged_out', reconnectAttempts: 0 };
    expect((await textOf('status')).split('\n')[0]).toContain('SESSION WHATSAPP DÉCONNECTÉE');
  });

  it('list_active_chats renvoie un tableau compact avec la colonne retenue', async () => {
    const out = await textOf('list_active_chats', { since: '2026-11-12' });
    const [head, ...rows] = out.split('\n');
    expect(head).toBe('chat_jid\tnom\ttype\tmessages\tdernier\tjustin_a_ecrit\tretenue');
    expect(rows.find((r) => r.startsWith(CHARLOTTE_PN))).toContain('Charlotte Dillies\tdirect\t4\t2026-11-12 18:33\toui\toui');
  });

  it('export_chat transcrit les vocaux puis donne date | auteur | corps', async () => {
    const out = await textOf('export_chat', { chat_jid: CHARLOTTE_PN, since: '2026-11-12' });
    expect(out.split('\n')).toEqual([
      'Charlotte Dillies (4 messages)',
      '2026-11-12 18:30 | Charlotte Dillies | Le mandat est signé',
      '2026-11-12 18:31 | Justin | Top, merci !',
      '2026-11-12 18:32 | Charlotte Dillies | [vocal 0:42] On visite samedi à dix heures',
      '2026-11-12 18:33 | Charlotte Dillies | [photo] La façade',
    ]);
  });

  it('search_messages trouve aussi dans les vocaux transcrits', async () => {
    await textOf('transcribe_voice_notes', {});
    const out = await textOf('search_messages', { query: 'samedi' });
    expect(out).toContain('[vocal 0:42] On visite samedi');
  });

  it('search_chats trouve la personne et le groupe partagé', async () => {
    const out = await textOf('search_chats', { query: 'charlotte' });
    expect(out).toContain(`${GROUPE_ILLIZ}\tÉquipe illiz\tgroupe\tCharlotte Dillies`);
  });

  it('get_attachment renvoie une photo comme image', async () => {
    const r = await call('get_attachment', { message_id: 'I' });
    expect(r.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
  });

  it('une date illisible donne une erreur claire, pas un plantage', async () => {
    const r = (await call('list_active_chats', { since: 'hier' })) as { isError?: boolean; content: { text?: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('date illisible');
  });
});

describe('dates en heure de Paris', () => {
  it('minuit à Paris, en hiver comme en été', () => {
    expect(new Date(parseDate('2026-11-12') * 1000).toISOString()).toBe('2026-11-11T23:00:00.000Z');
    expect(new Date(parseDate('2026-07-12') * 1000).toISOString()).toBe('2026-07-11T22:00:00.000Z');
    expect(formatTs(parseDate('2026-03-29 12:00'))).toBe('2026-03-29 12:00'); // jour du changement d'heure
  });
});

describe('porte d’entrée HTTP', () => {
  const app = () => createApp({ deps, mcpToken: TOKEN, adminPassword: 'mot-de-passe-admin-long' });
  const init = {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
  };
  const post = (headers: Record<string, string>) =>
    app().request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify(init),
    });

  it('refuse /mcp sans jeton ou avec un mauvais jeton', async () => {
    expect((await post({})).status).toBe(401);
    expect((await post({ authorization: `Bearer ${'b'.repeat(64)}` })).status).toBe(401);
  });

  it('accepte /mcp avec le bon jeton', async () => {
    const res = await post({ authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).toContain('whatsapp-justin');
  });

  it('protège /admin par mot de passe et y affiche le QR tant que l’appairage n’est pas fait', async () => {
    expect((await app().request('/admin')).status).toBe(401);
    state = { status: 'waiting_qr', qr: '2@abc,def', reconnectAttempts: 0 };
    const ok = await app().request('/admin', {
      headers: { authorization: `Basic ${Buffer.from('justin:mot-de-passe-admin-long').toString('base64')}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('<svg');
  });
});
