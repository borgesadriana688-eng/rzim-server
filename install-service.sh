#!/usr/bin/env bash
# =============================================================
#  RZIM 24H - transforma o servidor em servico do Termux
#  Roda UMA VEZ. Depois disso o servidor:
#    - sobe sozinho quando o Termux abrir (e no boot, com o app Termux:Boot)
#    - reinicia sozinho se cair
#    - atualiza do GitHub sozinho ao iniciar
#  Comandos:  sv up rzim | sv restart rzim | sv status rzim | sv down rzim
#  Logs:      tail -f $PREFIX/var/log/rzim-server.log
# =============================================================
cd "$(dirname "$0")" || exit 1
PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"

G='\033[1;32m'; R='\033[0r'; Y='\033[1;33m'; RD='\033[1;31m'
ok()   { printf "${G}[OK]${R} %s\n" "$1"; }
warn() { printf "${Y}[AVISO]${R} %s\n" "$1"; }
erro() { printf "${RD}[ERRO]${R} %s\n" "$1"; }

printf "\n${G}==== RZIM 24H ====${R}\n\n"

# 1) termux-services (o supervisor que reinicia o que cai)
if ! command -v sv >/dev/null 2>&1; then
  printf "Instalando o termux-services...\n"
  pkg install -y termux-services || { erro "falhou (pkg install termux-services)"; exit 1; }
fi
ok "termux-services instalado"

# 2) define o servico
SVC="$PREFIX/var/service/rzim"
mkdir -p "$SVC" "$PREFIX/var/log"

cat > "$SVC/run" <<EOF
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock 2>/dev/null
cd "$HOME/rzim-server" || exit 1
git pull --ff-only -q 2>/dev/null
exec bash start.sh >> "$PREFIX/var/log/rzim-server.log" 2>&1
EOF
chmod +x "$SVC/run"
ok "servico criado ($SVC)"

# 3) sobe no boot do celular (precisa do app Termux:Boot instalado 1 vez)
mkdir -p "$HOME/.termux/boot"
cat > "$HOME/.termux/boot/rzim-boot.sh" <<EOF
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock 2>/dev/null
sv up rzim 2>/dev/null
EOF
chmod +x "$HOME/.termux/boot/rzim-boot.sh"
ok "script de boot criado"

# 4) para o servidor manual (se estiver rodando) e sobe o servico
pkill -f 'node termux'  >/dev/null 2>&1; true
pkill -f 'ms-arm64'     >/dev/null 2>&1; true
sleep 1

sv up rzim 2>/dev/null || true

printf "\nPronto! O servidor agora e ${G}24 horas${R}.\n"
printf "Status:   ${Y}sv status rzim${R}\n"
printf "Logs:     ${Y}tail -f \$PREFIX/var/log/rzim-server.log${R}\n"
printf "Reiniciar: ${Y}sv restart rzim${R}\n"
printf "Parar:     ${Y}sv down rzim${R}\n\n"
warn "Pro boot automatico, instale o app 'Termux:Boot' no F-Droid e abra 1 vez."
