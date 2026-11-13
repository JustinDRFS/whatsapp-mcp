import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store/store.js';
import { CREDIT_ALERT, VoiceQueue } from '../src/voice/queue.js';
import { OpenAITranscriber, OutOfCreditError, type Transcriber } from '../src/voice/transcriber.js';
import { isSafeMediaLocation, type MediaFetcher } from '../src/whatsapp/media.js';
import type { StoredMessage } from '../src/whatsapp/types.js';
import { CHARLOTTE_PN } from './fixtures.js';

const NOW = 1_794_500_000;
const DAY = 86_400;

function voice(id: string, ts = NOW): StoredMessage {
  return { id, chatJid: CHARLOTTE_PN, senderJid: CHARLOTTE_PN, fromMe: false, timestamp: ts, type: 'voice', body: '', raw: { key: { id } }, durationSec: 10 };
}

const okFetcher: MediaFetcher = { fetch: async () => ({ data: Buffer.from('ogg'), mimetype: 'audio/ogg; codecs=opus' }) };

class ScriptedTranscriber implements Transcriber {
  calls = 0;
  inFlight = 0;
  maxInFlight = 0;
  constructor(private readonly script: (n: number) => string | Error) {}
  async transcribe(): Promise<string> {
    this.calls++;
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await new Promise((r) => setTimeout(r, 1));
    this.inFlight--;
    const out = this.script(this.calls);
    if (out instanceof Error) throw out;
    return out;
  }
}

let store: Store;
beforeEach(() => {
  store = new Store(':memory:');
});

const statusOf = (id: string) => store.findMessage(id)?.transcript_status;

describe('file de transcription', () => {
  it('transcrit un vocal et le rend cherchable', async () => {
    store.saveMessages([voice('V1')]);
    const q = new VoiceQueue(store, okFetcher, new ScriptedTranscriber(() => 'On signe le mandat lundi'), undefined, () => NOW);
    expect(await q.run()).toMatchObject({ done: 1 });
    expect(statusOf('V1')).toBe('done');
    expect(store.searchMessages('mandat')[0]?.id).toBe('V1');
  });

  it('traite un vocal à la fois, même si deux demandes arrivent ensemble', async () => {
    store.saveMessages([voice('A'), voice('B'), voice('C')]);
    const t = new ScriptedTranscriber(() => 'ok');
    const q = new VoiceQueue(store, okFetcher, t);
    await Promise.all([q.run({ limit: 3 }), q.run({ limit: 3 })]);
    expect(t.maxInFlight).toBe(1);
    expect(t.calls).toBe(3); // la seconde demande ne refait pas les vocaux déjà faits
  });

  it('marque « missing » un vocal dont le fichier n’existe plus', async () => {
    store.saveMessages([voice('V1')]);
    const q = new VoiceQueue(store, { fetch: async () => null }, new ScriptedTranscriber(() => 'x'));
    expect(await q.run()).toMatchObject({ missing: 1 });
    expect(statusOf('V1')).toBe('missing');
  });

  it('crédit épuisé : s’arrête, laisse les vocaux en attente et lève une alerte (leçon du 06/11)', async () => {
    store.saveMessages([voice('A', NOW), voice('B', NOW - 1)]);
    const q = new VoiceQueue(store, okFetcher, new ScriptedTranscriber(() => new OutOfCreditError()), undefined, () => NOW);
    expect(await q.run({ limit: 5 })).toMatchObject({ outOfCredit: true, failed: 0 });
    expect([statusOf('A'), statusOf('B')]).toEqual(['pending', 'pending']);
    expect(store.getMeta(CREDIT_ALERT)).toBe(String(NOW));
  });

  it('l’alerte disparaît dès qu’une transcription réussit à nouveau', async () => {
    store.saveMessages([voice('A')]);
    store.setMeta(CREDIT_ALERT, String(NOW));
    await new VoiceQueue(store, okFetcher, new ScriptedTranscriber(() => 'ok')).run();
    expect(store.getMeta(CREDIT_ALERT)).toBeNull();
  });

  it('un échec ordinaire passe en « failed » et peut être relancé', async () => {
    store.saveMessages([voice('A')]);
    const t = new ScriptedTranscriber((n) => (n === 1 ? new Error('OpenAI 500') : 'deuxième essai'));
    const q = new VoiceQueue(store, okFetcher, t);
    await q.run();
    expect(statusOf('A')).toBe('failed');
    await q.run(); // sans l'option, on ne relance pas
    expect(statusOf('A')).toBe('failed');
    await q.run({ retryFailed: true });
    expect(store.findMessage('A')?.transcript).toBe('deuxième essai');
  });

  it('en fond, ne prend que les 30 derniers jours', async () => {
    store.saveMessages([voice('RECENT', NOW - 2 * DAY), voice('VIEUX', NOW - 40 * DAY)]);
    const q = new VoiceQueue(store, okFetcher, new ScriptedTranscriber(() => 'ok'), undefined, () => NOW);
    q.startBackground(60_000);
    q.stop();
    await q.run({ since: NOW }); // attend la fin du passage de fond (même verrou)
    expect([statusOf('RECENT'), statusOf('VIEUX')]).toEqual(['done', 'pending']);
  });
});

describe('OpenAITranscriber', () => {
  const fakeFetch = (status: number, body: string) =>
    (async () => new Response(body, { status })) as unknown as typeof fetch;

  it('renvoie le texte', async () => {
    const t = new OpenAITranscriber({ apiKey: 'k', fetchImpl: fakeFetch(200, ' Bonjour \n') });
    expect(await t.transcribe(Buffer.from('x'), 'audio/ogg')).toBe('Bonjour');
  });

  it('reconnaît un crédit épuisé', async () => {
    const t = new OpenAITranscriber({ apiKey: 'k', fetchImpl: fakeFetch(429, '{"error":{"code":"insufficient_quota"}}') });
    await expect(t.transcribe(Buffer.from('x'), 'audio/ogg')).rejects.toBeInstanceOf(OutOfCreditError);
  });

  it('n’écrit jamais la clé dans le message d’erreur', async () => {
    const t = new OpenAITranscriber({ apiKey: 'sk-secret', fetchImpl: fakeFetch(401, 'bad key sk-secret') });
    await expect(t.transcribe(Buffer.from('x'), 'audio/ogg')).rejects.toThrow(/^clé OpenAI refusée$/);
  });
});

describe('protection SSRF des médias', () => {
  it('accepte les adresses de WhatsApp', () => {
    expect(isSafeMediaLocation('https://mmg.whatsapp.net/v/t62/abc', '/v/t62/abc')).toBe(true);
    expect(isSafeMediaLocation(undefined, '/v/t62/abc')).toBe(true);
  });

  it('refuse tout le reste', () => {
    expect(isSafeMediaLocation('https://evil.com/x', '/x')).toBe(false);
    expect(isSafeMediaLocation('https://whatsapp.net.evil.com/x', '/x')).toBe(false);
    expect(isSafeMediaLocation('http://mmg.whatsapp.net/x', '/x')).toBe(false);
    expect(isSafeMediaLocation('https://user@mmg.whatsapp.net/x', '/x')).toBe(false);
    expect(isSafeMediaLocation(undefined, '//evil.com/x')).toBe(false);
    expect(isSafeMediaLocation(undefined, 'evil.com/x')).toBe(false);
    expect(isSafeMediaLocation(undefined, undefined)).toBe(false);
  });
});
