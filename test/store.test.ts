import { beforeEach, describe, expect, it } from 'vitest';
import { Store, ftsQuery, isMasked, phoneOf } from '../src/store/store.js';
import { ingestMessages } from '../src/whatsapp/ingest.js';
import type { StoredMessage } from '../src/whatsapp/types.js';
import { CHARLOTTE_LID, CHARLOTTE_PN, GROUPE_ILLIZ, msg } from './fixtures.js';

const KEVIN_PN = '33622222222@s.whatsapp.net';
const DAY = 86_400;
const T0 = 1_794_500_000;

function m(partial: Partial<StoredMessage> & { id: string }): StoredMessage {
  return {
    chatJid: CHARLOTTE_PN,
    senderJid: CHARLOTTE_PN,
    fromMe: false,
    timestamp: T0,
    type: 'text',
    body: '',
    raw: {},
    ...partial,
  };
}

let s: Store;
beforeEach(() => {
  s = new Store(':memory:');
});

describe('rangement des messages', () => {
  it('range un message et le retrouve dans l’export', () => {
    s.saveMessages([m({ id: 'A', body: 'Bonjour' })]);
    expect(s.exportChat(CHARLOTTE_PN).map((r) => r.body)).toEqual(['Bonjour']);
  });

  it('ne crée pas de doublon quand l’historique renvoie le même message', () => {
    s.saveMessages([m({ id: 'A', body: 'Bonjour' })]);
    s.saveMessages([m({ id: 'A', body: 'Bonjour' })]);
    expect(s.status().messages).toBe(1);
  });

  it('met un vocal en attente de transcription', () => {
    s.saveMessages([m({ id: 'V', type: 'voice', durationSec: 30 })]);
    expect(s.exportChat(CHARLOTTE_PN)[0].transcript_status).toBe('pending');
    expect(s.status().voicePending).toBe(1);
  });

  it('garde le message brut et le relit à l’identique, Buffer compris', () => {
    const raw = { key: { id: 'V' }, message: { audioMessage: { mediaKey: Buffer.from([1, 2, 3]) } } };
    s.saveMessages([m({ id: 'V', type: 'voice', raw })]);
    const back = s.getRaw(CHARLOTTE_PN, 'V') as typeof raw;
    expect(Buffer.isBuffer(back.message.audioMessage.mediaKey)).toBe(true);
    expect([...back.message.audioMessage.mediaKey]).toEqual([1, 2, 3]);
  });
});

describe('LID et numéros (piège n° 2)', () => {
  it('re-range sous le numéro les messages arrivés sous un LID', () => {
    s.saveMessages([m({ id: 'A', chatJid: CHARLOTTE_LID, senderJid: CHARLOTTE_LID, body: 'avant' })]);
    s.saveMessages([m({ id: 'B', body: 'après' })]);
    expect(s.listActiveChats(0)).toHaveLength(2); // Charlotte apparaît en double…
    s.saveLidMappings([{ lid: CHARLOTTE_LID, pn: CHARLOTTE_PN }]);
    const chats = s.listActiveChats(0);
    expect(chats).toHaveLength(1); // …puis une seule fois
    expect(s.exportChat(CHARLOTTE_PN).map((r) => r.sender_jid)).toEqual([CHARLOTTE_PN, CHARLOTTE_PN]);
  });

  it('range directement sous le numéro quand la correspondance est déjà connue', () => {
    s.saveLidMappings([{ lid: CHARLOTTE_LID, pn: CHARLOTTE_PN }]);
    s.saveMessages([m({ id: 'A', chatJid: GROUPE_ILLIZ, senderJid: CHARLOTTE_LID })]);
    expect(s.exportChat(GROUPE_ILLIZ)[0].sender_jid).toBe(CHARLOTTE_PN);
  });

  it('apprend la correspondance depuis le message lui-même', () => {
    s.saveMessages([m({ id: 'A', chatJid: GROUPE_ILLIZ, senderJid: CHARLOTTE_LID, senderAltJid: CHARLOTTE_PN })]);
    expect(s.canonical(CHARLOTTE_LID)).toBe(CHARLOTTE_PN);
  });

  it('fusionne la fiche contact du LID dans celle du numéro', () => {
    s.saveContacts([{ jid: CHARLOTTE_LID, savedName: 'Charlotte Dillies' }]);
    s.saveLidMappings([{ lid: CHARLOTTE_LID, pn: CHARLOTTE_PN }]);
    expect(s.displayName(CHARLOTTE_PN)).toBe('Charlotte Dillies');
  });
});

describe('noms (piège n° 6)', () => {
  it('préfère le carnet d’adresses au nom de profil', () => {
    s.saveContacts([{ jid: CHARLOTTE_PN, savedName: 'Charlotte illiz', pushName: 'Chacha' }]);
    expect(s.displayName(CHARLOTTE_PN)).toBe('Charlotte illiz');
  });

  it('écarte un nom masqué et retombe sur le nom de profil, puis le numéro', () => {
    s.saveChats([{ jid: CHARLOTTE_PN, name: '+33∙∙∙11' }]);
    s.saveMessages([m({ id: 'A', pushName: 'Charlotte' })]);
    expect(s.displayName(CHARLOTTE_PN)).toBe('Charlotte');
    expect(s.displayName(KEVIN_PN)).toBe('+33622222222');
  });

  it('nomme Justin « Justin »', () => {
    expect(s.displayName('me')).toBe('Justin');
  });
});

describe('modifications et suppressions', () => {
  it('applique une modification faite par l’auteur', () => {
    s.saveMessages([m({ id: 'A', body: 'v1' })]);
    s.applyEdit({ chatJid: CHARLOTTE_PN, targetId: 'A', authorJid: CHARLOTTE_PN, newBody: 'v2', editedAt: T0 + 60 });
    expect(s.exportChat(CHARLOTTE_PN)[0]).toMatchObject({ body: 'v2', edited_at: T0 + 60 });
  });

  it('refuse une modification venant de quelqu’un d’autre', () => {
    s.saveMessages([m({ id: 'A', chatJid: GROUPE_ILLIZ, body: 'v1' })]);
    s.applyEdit({ chatJid: GROUPE_ILLIZ, targetId: 'A', authorJid: KEVIN_PN, newBody: 'piraté', editedAt: T0 });
    expect(s.exportChat(GROUPE_ILLIZ)[0].body).toBe('v1');
  });

  it('une suppression pour tous efface le contenu mais garde la trace', () => {
    s.saveMessages([m({ id: 'A', body: 'oups' })]);
    s.applyRevoke({ chatJid: CHARLOTTE_PN, targetId: 'A', authorJid: CHARLOTTE_PN, revokedAt: T0 + 5 });
    const row = s.exportChat(CHARLOTTE_PN)[0];
    expect(row).toMatchObject({ body: '', deleted_at: T0 + 5 });
    expect(s.getRaw(CHARLOTTE_PN, 'A')).toBeUndefined();
    expect(s.searchMessages('oups')).toHaveLength(0);
  });

  it('un message déjà modifié n’est pas écrasé par un renvoi de l’historique', () => {
    s.saveMessages([m({ id: 'A', body: 'v1' })]);
    s.applyEdit({ chatJid: CHARLOTTE_PN, targetId: 'A', authorJid: CHARLOTTE_PN, newBody: 'v2', editedAt: T0 });
    s.saveMessages([m({ id: 'A', body: 'v1' })]);
    expect(s.exportChat(CHARLOTTE_PN)[0].body).toBe('v2');
  });
});

describe('recherche plein texte', () => {
  it('trouve sans tenir compte des accents ni des majuscules', () => {
    s.saveMessages([m({ id: 'A', body: 'Réunion à Aix-les-Bains demain' })]);
    expect(s.searchMessages('reunion AIX')).toHaveLength(1);
  });

  it('ne plante pas sur des caractères spéciaux (chaque mot entre guillemets)', () => {
    s.saveMessages([m({ id: 'A', body: 'prix: 250000 €' })]);
    expect(() => s.searchMessages('prix: "OR" NOT (')).not.toThrow();
    expect(ftsQuery('a "b" c')).toBe('"a" "b" "c"');
  });

  it('filtre par date et par conversation', () => {
    s.saveMessages([
      m({ id: 'A', body: 'visite', timestamp: T0 - 10 * DAY }),
      m({ id: 'B', body: 'visite', timestamp: T0 }),
      m({ id: 'C', chatJid: KEVIN_PN, senderJid: KEVIN_PN, body: 'visite', timestamp: T0 }),
    ]);
    expect(s.searchMessages('visite', T0 - DAY)).toHaveLength(2);
    expect(s.searchMessages('visite', 0, CHARLOTTE_PN)).toHaveLength(2);
  });
});

describe('conversations actives', () => {
  beforeEach(() => {
    const bigGroup = '120363000000000099@g.us';
    s.saveMessages([
      m({ id: 'D1', body: 'direct' }),
      m({ id: 'G1', chatJid: GROUPE_ILLIZ, body: 'petit groupe' }),
      ...Array.from({ length: 12 }, (_, i) =>
        m({ id: `B${i}`, chatJid: bigGroup, senderJid: `336000000${i}@s.whatsapp.net`, body: 'gros groupe' }),
      ),
    ]);
  });

  it('retient les directes et les petits groupes, pas les gros groupes', () => {
    const kept = Object.fromEntries(s.listActiveChats(0).map((c) => [c.jid, c.kept]));
    expect(kept[CHARLOTTE_PN]).toBe(true);
    expect(kept[GROUPE_ILLIZ]).toBe(true);
    expect(kept['120363000000000099@g.us']).toBe(false);
  });

  it('retient un gros groupe si Justin y a écrit, ou s’il est épinglé', () => {
    const big = '120363000000000099@g.us';
    s.setAlwaysKeep(big, true);
    expect(s.listActiveChats(0).find((c) => c.jid === big)?.kept).toBe(true);
  });

  it('respecte la fenêtre de dates', () => {
    expect(s.listActiveChats(T0 + 1)).toHaveLength(0);
  });
});

describe('recherche de conversations', () => {
  it('trouve une personne par son nom sans accent et les groupes partagés', () => {
    s.saveContacts([{ jid: CHARLOTTE_PN, savedName: 'Charlotte Dillies' }]);
    s.saveChats([{ jid: GROUPE_ILLIZ, name: 'Équipe illiz' }]);
    s.saveMessages([m({ id: 'G', chatJid: GROUPE_ILLIZ, body: 'hello' })]);
    const r = s.searchChats('charlotte');
    expect(r.map((c) => c.jid)).toEqual([CHARLOTTE_PN, GROUPE_ILLIZ]);
    expect(r[1]).toMatchObject({ name: 'Équipe illiz', via: 'Charlotte Dillies' });
    expect(s.searchChats('equipe')[0].jid).toBe(GROUPE_ILLIZ);
  });

  it('trouve par numéro', () => {
    s.saveMessages([m({ id: 'A' })]);
    expect(s.searchChats('06 11 11 11')[0]?.jid).toBe(CHARLOTTE_PN);
  });
});

describe('de bout en bout : pièce 1 vers pièce 2', () => {
  it('un faux message Baileys arrive jusqu’à la recherche', () => {
    ingestMessages(s, [
      msg({
        key: { remoteJid: GROUPE_ILLIZ, participant: CHARLOTTE_LID, participantAlt: CHARLOTTE_PN },
        message: { conversation: 'Le mandat de la villa est signé' },
        pushName: 'Charlotte',
      }),
    ]);
    const [hit] = s.searchMessages('mandat');
    expect(hit).toMatchObject({ chat_jid: GROUPE_ILLIZ, sender_jid: CHARLOTTE_PN });
    expect(s.displayName(hit.sender_jid)).toBe('Charlotte');
  });
});

describe('outils', () => {
  it('phoneOf et isMasked', () => {
    expect(phoneOf(CHARLOTTE_PN)).toBe('+33611111111');
    expect(phoneOf(CHARLOTTE_LID)).toBeNull();
    expect(isMasked('+33∙∙∙08')).toBe(true);
    expect(isMasked('Kévin')).toBe(false);
  });
});
