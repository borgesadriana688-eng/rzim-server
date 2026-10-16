#!/usr/bin/env bash
# update.sh — atualiza e reinicia o servidor rzim no Termux.
# Uso:  bash update.sh   (dentro da pasta do servidor)
R="$(cd "$(dirname "$0")" && pwd)"
cd "$R" || exit 1
echo "==> pasta do servidor: $R"

echo "==> git pull..."
OUT=$(git pull origin main 2>&1) || { echo "ERRO NO GIT PULL:"; echo "$OUT"; echo "manda um print disso pro agente"; exit 1; }
echo "$OUT" | tail -2

echo "==> parando servidor antigo..."
ps -ef 2>/dev/null | grep 'node termux.js' | grep -v grep | awk '{print $2}' | while read p; do kill "$p" 2>/dev/null; done
sleep 2

echo "==> redis..."
if command -v redis-cli >/dev/null; then
    redis-cli ping 2>/dev/null | grep -q PONG || redis-server --daemonize yes
fi

echo "==> subindo servidor novo..."
rm -f "$HOME/rzim-termux.log"
nohup node termux.js > "$HOME/rzim-termux.log" 2>&1 &
sleep 10

echo "==> ultimas linhas do log:"
tail -4 "$HOME/rzim-termux.log"

echo "==> teste da porta 18000:"
if command -v curl >/dev/null; then
    curl -s -m 5 -o /dev/null -w "porta 18000: HTTP %{http_code} (TA OK)\n" http://127.0.0.1:18000/ver.php || echo "porta 18000 NAO respondeu"
else
    echo "sem curl instalado (pkg install curl)"
fi
echo "==> se disse HTTP 200 acima: abre o jogo que o login aparece."
