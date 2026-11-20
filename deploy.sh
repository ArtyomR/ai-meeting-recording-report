#!/usr/bin/env bash
# Сборка stage и деплой на ZCode Sites одной командой:  bash deploy.sh
# Секреты читаются из локального .env и вшиваются только в stage/start.sh —
# в git они не попадают (.env и .zcode-site/ в .gitignore).
set -euo pipefail
cd "$(dirname "$0")"

ZCODE_SITE="C:/Users/MSI/.zcode/cli/plugins/cache/zcode-plugins-official/zcode-site/0.5.0/scripts/zcode-site.mjs"

get_env() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | tr -d '\r' | sed 's/^"//; s/"$//'; }

rm -rf .zcode-site/stage
mkdir -p .zcode-site/stage
cp server.js index.html app.js styles.css icon.svg package.json .zcode-site/stage/

STATS_HASH="$(get_env STATS_KEY | tr -d '\r\n' | sha256sum | cut -d' ' -f1)"
TG_TOKEN="$(get_env TELEGRAM_BOT_TOKEN)"
TG_CHAT="$(get_env TELEGRAM_CHAT_ID)"

cat > .zcode-site/stage/start.sh <<EOF
#!/usr/bin/env bash
# ZCode Sites start.sh. Runs in the foreground on 0.0.0.0:3000.
# Сгенерирован deploy.sh: секреты вшиты из локального .env при сборке.
set -euo pipefail
cd "\$(dirname "\${BASH_SOURCE[0]}")"

export NODE_ENV=production
export PORT="\${PORT:-3000}"
export HOST=0.0.0.0 HOSTNAME=0.0.0.0
export NODE_OPTIONS="\${NODE_OPTIONS:---max-old-space-size=768}"
# Writable but temporary storage (lost when the instance is recycled).
export DATA_DIR="\${DATA_DIR:-\$PWD/data}"
mkdir -p "\$DATA_DIR"

export STATS_KEY_SHA256="$STATS_HASH"
export TELEGRAM_BOT_TOKEN="$TG_TOKEN"
export TELEGRAM_CHAT_ID="$TG_CHAT"

exec node server.js
EOF

node "$ZCODE_SITE" check .zcode-site/stage
node "$ZCODE_SITE" deploy .zcode-site/stage --quiet
