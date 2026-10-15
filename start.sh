#!/usr/bin/env bash
# =============================================================
#  RZIM - servidor completo do jogo no Termux (UM COMANDO SO)
#  Roda: git pull + deps + redis + servidor de partida + lobby
# =============================================================
cd "$(dirname "$0")" || exit 1

G='\033[1;32m'; R='\033[0m'; Y='\033[1;33m'; RD='\033[1;31m'
ok()   { printf "${G}[OK]${R} %s\n" "$1"; }
warn() { printf "${Y}[AVISO]${R} %s\n" "$1"; }
erro() { printf "${RD}[ERRO]${R} %s\n" "$1"; }

printf "\n${G}==== SERVIDOR RZIM NO TERMUX ====${R}\n\n"

# 1) pacotes que faltam
if ! command -v node >/dev/null 2>&1; then
  printf "Instalando o Node (vai demorar um pouco)...\n"
  pkg install -y nodejs-lts || { erro "nao deu pra instalar o Node"; exit 1; }
fi
ok "Node $(node -v)"
if ! command -v redis-server >/dev/null 2>&1; then
  printf "Instalando o Redis...\n"
  pkg install -y redis || warn "nao deu pra instalar o Redis (o servidor sobe igual)"
fi
[ -n "$(command -v redis-server)" ] && ok "Redis instalado"
termux-wake-lock >/dev/null 2>&1 || true

# 2) codigo atualizado
printf "Atualizando o servidor (git pull)...\n"
git pull --ff-only >/dev/null 2>&1 || warn "nao consegui atualizar (sem internet? segue com o que tem)"

# 3) dependencias do Node
if [ ! -d node_modules/express ]; then
  printf "Instalando dependencias (primeira vez demora)...\n"
  npm install --ignore-scripts || { erro "falha no npm install"; exit 1; }
fi
ok "Dependencias prontas"

# 4) configuracao
[ -f .env ] || cp .env.termux .env
ok "Configuracao pronta"

# 5) redis rodando
redis-cli ping >/dev/null 2>&1 || redis-server --daemonize yes >/dev/null 2>&1
sleep 1
if redis-cli ping 2>/dev/null | grep -q PONG; then
  ok "Redis rodando"
else
  warn "Redis nao respondeu (o servidor sobe igual, mas sem amigos online)"
fi

# 6) mata processos antigos que ocupam as portas (ponte velha, servidor velho)
pkill -f ff143_bridge  >/dev/null 2>&1; true
pkill -f 'bridge.py'   >/dev/null 2>&1; true
pkill -f 'node termux'  >/dev/null 2>&1; true
pkill -f 'ms-arm64'     >/dev/null 2>&1; true
sleep 1

# 7) servidor de PARTIDA (UDP 10100) em segundo plano
if [ -f bin/ms-arm64 ]; then
  chmod +x bin/ms-arm64
  REDIS_URL=redis://127.0.0.1:6379 MATCH_ADVERTISE=127.0.0.1:10100 MATCH_BOT=1 \
    nohup ./bin/ms-arm64 > "$HOME/ms.log" 2>&1 &
  sleep 2
  if pgrep -f 'bin/ms-arm64' >/dev/null 2>&1; then
    ok "Servidor de PARTIDA rodando (UDP 10100)"
  else
    warn "Servidor de partida nao subiu - veja $HOME/ms.log"
  fi
else
  warn "bin/ms-arm64 nao encontrado (partidas podem nao funcionar)"
fi

# 8) servidor do LOBBY na frente (HTTP + TCP)
printf "\n${G}==== TUDO PRONTO - ABRA O JOGO AGORA ====${R}\n"
printf "Se aparecer erro abaixo, tire print e mande no chat.\n\n"
# versao do cliente: "bash start.sh" = 1.70 | "bash start.sh 143" = cliente 1.43 (MID5)
case "${1:-170}" in
  143) GAME_V=1.43.0 ;;
  *)   GAME_V=1.70.0 ;;
esac
printf "Versao do cliente: %s\n" "$GAME_V"
exec env TERMUX_HTTP_PORTS=18000,18001,5008 MAIN_PORT=18001 TCP_PORT=18002 \
  TCP_PUBLIC_HOST=127.0.0.1 MATCH_PUBLIC_HOST=127.0.0.1 \
  LOGIN_DOMAIN=http://127.0.0.1:18000/ GAME_VERSION="$GAME_V" \
  node termux.js
