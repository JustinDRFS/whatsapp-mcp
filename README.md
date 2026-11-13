# whatsapp-mcp

Serveur MCP **en lecture seule** qui recopie le WhatsApp de Justin pour son second brain (`/flux`, `/historique`). Construit d'après le kit `WHATSAPP-MCP.md` de Bateson (Freddy Mallet).

Le service se connecte comme un appareil lié (comme WhatsApp Web), recopie les conversations dans une base SQLite, transcrit les vocaux et expose des outils de lecture à Claude.

## Règles non négociables

- **Lecture seule** : aucune fonction d'envoi de Baileys (un test le vérifie), jamais « en ligne ».
- **Journaux sans contenu de message**, secrets jamais en argument d'une commande.
- **Une seule instance** : deux instances se volent la session WhatsApp.
- La base contient les messages des proches et collègues de Justin : elle ne quitte pas son compte.

## Avancement

| Pièce | État |
|---|---|
| 1. Connexion et lecture des événements | faite |
| 2. Base SQLite et recherche | faite |
| 3. Transcription des vocaux | à faire |
| 4. Outils MCP et serveur HTTP | à faire |

## Commandes

```bash
npm install
npm test        # tests, sans connexion à WhatsApp
npm run build
```
