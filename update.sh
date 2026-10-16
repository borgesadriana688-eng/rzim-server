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

echo "==> subindo servidor NO PRIMEIRO PLANO (Android mata node em background)."
echo "    Deixa essa tela aberta, nao fecha o Termux."
echo "    Quando aparecer \'servidor pronto. abre o jogo.\' -> abre o jogo."
echo ""
termux-wake-lock 2>/dev/null
exec node termux.js
