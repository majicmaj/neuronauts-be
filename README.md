# Neuronauts backend

The authoritative multiplayer game server for [Neuronauts](https://github.com/majicmaj/neuronauts). It uses GloVe embeddings for semantic similarity, midpoint hints, and a stable two-dimensional projection of guesses around each hidden target.

## Capabilities

- Socket.IO lobbies with unique random call signs and editable player names
- Server-authoritative guesses, attribution, wins, and shared state
- Versioned concept families for safe inflections and spelling variants, with canonical targets, rankings, hints, and duplicate recall
- Linear semantic scores calibrated from each target's background cosine floor, with ordinal rank retained as separate context
- Semantic-midpoint hints with a 60-second per-lobby cooldown
- Stable vector positions whose radius matches the displayed semantic score
- Server-assigned player colors persisted on attributed guesses
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
npm run lexicon:check
npm test
npm audit --omit=dev
```

The tests use small in-memory embeddings and include two-client Socket.IO scenarios covering unique identities, concurrent concept aliases, attributed guesses, shared hints/cooldowns, and synchronized wins.

Concept generation, review policy, spelling-source provenance, and override workflow are documented in [`lexicon/README.md`](lexicon/README.md). Runtime containers consume the committed generated JSON files; the linguistic build dependencies remain development-only.

Displayed percentages are not vocabulary percentiles. For each mission, the median cosine similarity of the reference vocabulary establishes the target's 0% background floor, the strongest available non-target word anchors 99.9%, and only the exact target is 100%. Scores are linear through that playable semantic range. The separately displayed `#rank / total` remains useful ordinal context without making every top-decile association look nearly correct.

## Docker

The image installs production dependencies, prepares the GloVe data on first boot, exposes port `3000`, includes a health check, and handles `SIGTERM` gracefully.

```bash
docker build -t neuronauts-be .
docker run --rm -p 3000:3000 -v neuronauts-data:/app/data neuronauts-be
```

The production compose layout and deployment procedure are documented in the parent workspace's `DEPLOYMENT.md`.
