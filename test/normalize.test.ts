import { proto } from '@whiskeysockets/baileys';
import { describe, expect, it } from 'vitest';
import { normalizeMessage, toSeconds } from '../src/whatsapp/normalize.js';
import { CHARLOTTE_LID, CHARLOTTE_PN, GROUPE_ILLIZ, msg } from './fixtures.js';

const asMessage = (m: ReturnType<typeof normalizeMessage>) => {
  if (m?.kind !== 'message') throw new Error(`attendu un message, reçu ${m?.kind}`);
  return m.message;
};

describe('normalizeMessage', () => {
  it('lit un texte simple', () => {
    const m = asMessage(normalizeMessage(msg({ message: { conversation: 'Salut Justin' }, pushName: 'Charlotte' })));
    expect(m).toMatchObject({ type: 'text', body: 'Salut Justin', senderJid: CHARLOTTE_PN, fromMe: false, pushName: 'Charlotte' });
  });

  it('lit un texte étendu (avec lien ou réponse)', () => {
    const m = asMessage(normalizeMessage(msg({ message: { extendedTextMessage: { text: 'Regarde ça' } } })));
    expect(m.body).toBe('Regarde ça');
  });

  it("reconnaît un vocal et sa durée", () => {
    const m = asMessage(normalizeMessage(msg({ message: { audioMessage: { ptt: true, seconds: 42 } } })));
    expect(m).toMatchObject({ type: 'voice', durationSec: 42, body: '' });
  });

  it('distingue un fichier audio d’un vocal', () => {
    const m = asMessage(normalizeMessage(msg({ message: { audioMessage: { ptt: false, seconds: 180 } } })));
    expect(m.type).toBe('audio');
  });

  it('garde la légende d’une photo et le nom d’un document', () => {
    expect(asMessage(normalizeMessage(msg({ message: { imageMessage: { caption: 'La façade' } } }))).body).toBe('La façade');
    expect(asMessage(normalizeMessage(msg({ message: { documentMessage: { fileName: 'mandat.pdf' } } }))).body).toBe('mandat.pdf');
  });

  it('marque mes propres messages', () => {
    const m = asMessage(normalizeMessage(msg({ key: { fromMe: true }, message: { conversation: 'Ok' } })));
    expect(m).toMatchObject({ senderJid: 'me', fromMe: true });
  });

  it('dans un groupe, l’auteur est le participant, avec son autre identifiant', () => {
    const m = asMessage(
      normalizeMessage(
        msg({
          key: { remoteJid: GROUPE_ILLIZ, participant: CHARLOTTE_LID, participantAlt: CHARLOTTE_PN },
          message: { conversation: 'Bonjour à tous' },
        }),
      ),
    );
    expect(m).toMatchObject({ chatJid: GROUPE_ILLIZ, senderJid: CHARLOTTE_LID, senderAltJid: CHARLOTTE_PN });
  });

  it('déballe les messages éphémères et à vue unique', () => {
    const m = asMessage(
      normalizeMessage(msg({ message: { ephemeralMessage: { message: { conversation: 'Message éphémère' } } } })),
    );
    expect(m.body).toBe('Message éphémère');
  });

  it('transforme une modification en événement edit', () => {
    const ev = normalizeMessage(
      msg({
        message: {
          protocolMessage: {
            type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
            key: { id: 'ORIGINAL' },
            editedMessage: { conversation: 'Texte corrigé' },
          },
        },
      }),
    );
    expect(ev).toMatchObject({ kind: 'edit', edit: { targetId: 'ORIGINAL', newBody: 'Texte corrigé', authorJid: CHARLOTTE_PN } });
  });

  it('transforme une suppression pour tous en événement revoke', () => {
    const ev = normalizeMessage(
      msg({ message: { protocolMessage: { type: proto.Message.ProtocolMessage.Type.REVOKE, key: { id: 'ORIGINAL' } } } }),
    );
    expect(ev).toMatchObject({ kind: 'revoke', revoke: { targetId: 'ORIGINAL', authorJid: CHARLOTTE_PN } });
  });

  it('ignore les statuts, les chaînes et les messages sans contenu', () => {
    expect(normalizeMessage(msg({ key: { remoteJid: 'status@broadcast' }, message: { conversation: 'x' } }))).toBeNull();
    expect(normalizeMessage(msg({ key: { remoteJid: '123@newsletter' }, message: { conversation: 'x' } }))).toBeNull();
    expect(normalizeMessage(msg({ message: undefined }))).toBeNull();
  });

  it('ignore les réactions', () => {
    expect(normalizeMessage(msg({ message: { reactionMessage: { text: '👍', key: { id: 'X' } } } }))).toBeNull();
  });

  it('garde le message brut pour retélécharger un média plus tard', () => {
    const original = msg({ message: { audioMessage: { ptt: true } } });
    expect(asMessage(normalizeMessage(original)).raw).toBe(original);
  });
});

describe('toSeconds', () => {
  it('accepte un nombre, un Long ou rien', () => {
    expect(toSeconds(12)).toBe(12);
    expect(toSeconds({ toNumber: () => 34 })).toBe(34);
    expect(toSeconds(null)).toBe(0);
  });
});
