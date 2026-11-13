// Garde-fou : le service ne doit jamais rien émettre sur WhatsApp.
// Si quelqu'un ajoute un appel d'envoi, ce test casse.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const FORBIDDEN = [
  'sendMessage',
  'sendPresenceUpdate',
  'presenceSubscribe',
  'readMessages',
  'sendReceipt',
  'sendReceipts',
  'chatModify',
  'relayMessage',
  'updateProfile',
  'groupCreate',
  'groupParticipantsUpdate',
  'groupLeave',
  'rejectCall',
  'star',
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('lecture seule', () => {
  it("aucun fichier de src n'appelle une fonction d'envoi de Baileys", () => {
    const offenders: string[] = [];
    for (const f of files('src')) {
      const code = readFileSync(f, 'utf8')
        .split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        .join('\n');
      for (const name of FORBIDDEN) {
        if (new RegExp(`\\b${name}\\s*\\(|\\.${name}\\b`).test(code)) offenders.push(`${f} : ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('la connexion ne se signale jamais « en ligne »', () => {
    expect(readFileSync('src/whatsapp/connection.ts', 'utf8')).toMatch(/markOnlineOnConnect:\s*false/);
  });
});
