# Neuronauts backend

The authoritative multiplayer game server for [Neuronauts](https://github.com/majicmaj/neuronauts). It uses GloVe embeddings for semantic similarity, midpoint hints, and a stable two-dimensional projection of guesses around each hidden target.

## Capabilities

- Socket.IO lobbies with unique random call signs and editable player names
- Server-authoritative guesses, attribution, wins, and shared state
- Nearest-vocabulary midpoint hints with a 60-second per-lobby cooldown
- Stable vector positions whose radius preserves cosine distance to the target
- Lobby/player capacity limits, guess rate limiting, input validation, bounded histories, stale-room cleanup, and graceful shutdown
- `/health` and `/stats` operational endpoints

## Local development

Requirements: Node.js 22 or newer and an `embeddings.json` generated from `glove.6B.200d.txt`.

```bash
npm ci
node server.js
```

Useful environment variables:

| Variable | Default |
| --- | --- |
| `PORT` | `3000` |
| `EMBEDDINGS_FILE` | `./embeddings.json` |
| `CORS_ORIGINS` | local and production Neuronauts origins |
| `MAX_LOBBIES` | `100` |
| `MAX_PLAYERS_PER_LOBBY` | `12` |
| `STALE_LOBBY_MS` | `1800000` |
| `CLEANUP_INTERVAL_MS` | `300000` |
| `GUESS_RATE_LIMIT_MS` | `250` |

Quality checks:

```bash
npm test
npm audit --omit=dev
```

The tests use small in-memory embeddings and include a two-client Socket.IO integration scenario covering unique identities, renaming, attributed guesses, shared hints/cooldowns, and synchronized wins.

## Docker

The image installs production dependencies, prepares the GloVe data on first boot, exposes port `3000`, includes a health check, and handles `SIGTERM` gracefully.

```bash
docker build -t neuronauts-be .
docker run --rm -p 3000:3000 -v neuronauts-data:/app/data neuronauts-be
```

The production compose layout and deployment procedure are documented in the parent workspace's `DEPLOYMENT.md`.
