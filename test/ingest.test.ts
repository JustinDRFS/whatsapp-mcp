import { describe, expect, it } from 'vitest';
import { attachIngest, pairOf } from '../src/whatsapp/ingest.js';
import { backoffDelayMs } from '../src/whatsapp/connection.js';
import { CHARLOTTE_LID, CHARLOTTE_PN, FakeEmitter, GROUPE_ILLIZ, MemorySink, msg } from './fixtures.js';

function setup() {
  const ev = new FakeEmitter();
  const sink = new MemorySink();
  const logs: string[] = [];
  attachIngest(ev, sink, (l) => logs.push(l));
  return { ev, sink, logs };
}

describe('attachIngest', () => {
  it('range les nouveaux messages', () => {
    const { ev, sink } = setup();
    ev.emit('messages.upsert', { type: 'notify', messages: [msg({ message: { conversation: 'Hello' } })] });
    expect(sink.messages).toHaveLength(1);
  });

  it('enregistre la correspondance LID ↔ numéro avant les messages', () => {
    const { ev, sink } = setup();
    ev.emit('messages.upsert', {
      type: 'notify',
      messages: [
        msg({
          key: { remoteJid: GROUPE_ILLIZ, participant: CHARLOTTE_LID, participantAlt: CHARLOTTE_PN },
          message: { conversation: 'Hello' },
        }),
      ],
    });
    expect(sink.mappings).toEqual([{ lid: CHARLOTTE_LID, pn: CHARLOTTE_PN }]);
    expect(sink.calls).toEqual(['mappings', 'messages']);
  });

  it('nourrit les correspondances depuis toutes les sources', () => {
    const { ev, sink } = setup();
    ev.emit('lid-mapping.update', { lid: 'a@lid', pn: '1@s.whatsapp.net' });
    ev.emit('contacts.upsert', [{ id: 'b@lid', phoneNumber: '2@s.whatsapp.net', name: 'Kévin' }]);
    ev.emit('group-participants.update', {
      id: GROUPE_ILLIZ,
      author: 'x',
      action: 'add',
      participants: [{ id: 'c@lid', phoneNumber: '3@s.whatsapp.net' }],
    });
    ev.emit('messaging-history.set', {
      chats: [{ id: 'd@lid', pnJid: '4@s.whatsapp.net', name: 'Fabien' }],
      contacts: [],
      messages: [],
      lidPnMappings: [{ lid: 'e@lid', pn: '5@s.whatsapp.net' }],
    });
    expect(sink.mappings.map((m) => m.lid).sort()).toEqual(['a@lid', 'b@lid', 'c@lid', 'd@lid', 'e@lid']);
    expect(sink.contacts[0]).toMatchObject({ savedName: 'Kévin', lid: 'b@lid', pn: '2@s.whatsapp.net' });
    expect(sink.chats[0]).toMatchObject({ name: 'Fabien' });
  });

  it('lit l’historique reçu à l’appairage et le résume sans contenu dans le journal', () => {
    const { ev, sink, logs } = setup();
    ev.emit('messaging-history.set', {
      chats: [{ id: CHARLOTTE_PN, name: 'Charlotte' }],
      contacts: [{ id: CHARLOTTE_PN, name: 'Charlotte Dillies' }],
      messages: [msg({ message: { conversation: 'Message secret' } })],
    });
    expect(sink.messages).toHaveLength(1);
    expect(logs.join('\n')).toContain('1 messages');
    expect(logs.join('\n')).not.toContain('secret');
  });

  it('applique une modification arrivée par messages.update', () => {
    const { ev, sink } = setup();
    ev.emit('messages.update', [
      {
        key: { remoteJid: CHARLOTTE_PN, id: 'U1', fromMe: false },
        update: { message: { protocolMessage: { type: 14, key: { id: 'ORIGINAL' }, editedMessage: { conversation: 'v2' } } } },
      },
    ]);
    expect(sink.edits).toMatchObject([{ targetId: 'ORIGINAL', newBody: 'v2' }]);
  });

  it('survit à un événement malformé, sans planter ni écrire de contenu', () => {
    const { ev, sink, logs } = setup();
    expect(() => ev.emit('messages.upsert', { messages: null })).not.toThrow();
    expect(sink.messages).toHaveLength(0);
    expect(logs[0]).toContain('échec');
  });
});

describe('pairOf', () => {
  it('reconnaît un couple dans les deux sens et ignore le reste', () => {
    expect(pairOf(CHARLOTTE_LID, CHARLOTTE_PN)).toEqual({ lid: CHARLOTTE_LID, pn: CHARLOTTE_PN });
    expect(pairOf(CHARLOTTE_PN, CHARLOTTE_LID)).toEqual({ lid: CHARLOTTE_LID, pn: CHARLOTTE_PN });
    expect(pairOf(CHARLOTTE_PN, undefined)).toBeNull();
  });
});

describe('backoffDelayMs', () => {
  it('double à chaque essai et plafonne à 5 minutes', () => {
    expect([0, 1, 2, 3].map(backoffDelayMs)).toEqual([2000, 4000, 8000, 16000]);
    expect(backoffDelayMs(20)).toBe(300_000);
  });
});
