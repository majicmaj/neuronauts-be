#!/usr/bin/env bash
set -euo pipefail

DATA_DIR=/app/data
EMBEDDINGS_JSON="${EMBEDDINGS_FILE:-$DATA_DIR/embeddings.json}"
GLOVE_TXT="$DATA_DIR/glove.6B.200d.txt"
GLOVE_ZIP="$DATA_DIR/glove.6B.zip"

mkdir -p "$DATA_DIR"

if [ ! -f "$EMBEDDINGS_JSON" ]; then
  echo "[entrypoint] embeddings.json missing; preparing GloVe data"

  if [ ! -f "$GLOVE_TXT" ]; then
    if [ ! -f "$GLOVE_ZIP" ]; then
      echo "[entrypoint] downloading GloVe archive"
      curl -fL https://nlp.stanford.edu/data/glove.6B.zip -o "$GLOVE_ZIP"
    fi

    echo "[entrypoint] extracting glove.6B.200d.txt"
    unzip -o "$GLOVE_ZIP" glove.6B.200d.txt -d "$DATA_DIR"
  fi

  echo "[entrypoint] converting glove.6B.200d.txt -> embeddings.json (one-time)"
  python3 clove_to_json.py <<'EOF'
EOF
  mv -f embeddings.json "$EMBEDDINGS_JSON"
fi

exec "$@"
