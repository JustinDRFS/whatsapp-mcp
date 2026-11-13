// Point d'entrée : assemble les quatre pièces et démarre le serveur.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { createApp } from './http/app.js';
import { Store } from './store/store.js';
import { VoiceQueue } from './voice/queue.js';
import { OpenAITranscriber } from './voice/transcriber.js';
import { WhatsAppConnection } from './whatsapp/connection.js';
import { BaileysMediaFetcher } from './whatsapp/media.js';

const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });

const store = new Store(join(config.dataDir, 'whatsapp.db'));
const connection = new WhatsAppConnection({ authDir: join(config.dataDir, 'auth'), sink: store, log });
const media = new BaileysMediaFetcher(() => connection.socket);
const voices = config.openaiApiKey
  ? new VoiceQueue(store, media, new OpenAITranscriber({ apiKey: config.openaiApiKey, model: config.openaiModel }), log)
  : undefined;

// Quand la session s'ouvre : taille et nom des groupes (lecture seule), puis vocaux en fond.
connection.onOpen = async (sock) => {
  try {
    const groups = await sock.groupFetchAllParticipating();
    for (const g of Object.values(groups)) {
      store.setGroupParticipants(g.id, g.participants.length);
      store.saveChats([{ jid: g.id, name: g.subject }]);
    }
    log(`groupes : ${Object.keys(groups).length} mis à jour`);
  } catch {
    log('groupes : lecture impossible pour le moment');
  }
};

const app = createApp({
  deps: { store, voices, media, connection: () => connection.state },
  mcpToken: config.mcpToken,
  adminPassword: config.adminPassword,
  publicHost: config.publicHost,
});

await connection.start();
voices?.startBackground();
serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' });
log(`serveur prêt sur le port ${config.port}${voices ? '' : ' (transcription désactivée : pas de clé OpenAI)'}`);

const shutdown = () => {
  log('arrêt');
  voices?.stop();
  connection.stop();
  store.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
