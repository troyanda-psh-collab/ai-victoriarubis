#!/usr/bin/env bash
# agent-watchdog.sh — держит агента живым: перезапускает при падении,
# чистит зависшие копии-дубликаты, замечает исчерпание лимита Claude
# и пишет владельцу напрямую, когда агент сам ответить не может.
set -uo pipefail
export HOME="${HOME:-/root}"
# ~/.local/bin — туда Claude Code ставит себя при самообновлении, ~/.bun/bin —
# движок моста. Без этих двух папок в путях перезапущенный агент падает с
# ошибкой "claude: No such file or directory".
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
# Сторож — системная служба (root, не пользовательская сессия), а команды
# `systemctl --user` (для Hermes-агентов) без этого не видят службы вообще:
# молча решают, что агент упал, хотя он жив. Нужно, даже если Hermes-агентов
# пока нет.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/0}"

LOG="${WATCHDOG_LOG:-$HOME/watchdog.log}"
INTERVAL="${WATCHDOG_INTERVAL:-5}"
COOLDOWN="${WATCHDOG_COOLDOWN:-30}"
GRACE="${WATCHDOG_GRACE:-60}"

# ЗАПОЛНИ ПОД СЕБЯ: имя tmux-сессии -> папка агента (там, где start.sh)
declare -A AGENTS=(
  [agent]="/root/ai-victoriarubis"
)

# Агент на ДРУГОМ движке (Hermes) — не тмукс-сессия, а systemd-служба, живёт
# по своим правилам. Пусто, пока такого агента нет; появится — впиши сюда имя
# службы и путь к его дому (см. раздел про Hermes ниже, после Шага 3).
declare -A HERMES=()
declare -A HERMES_WHO=()

declare -A LAST_RESTART=()
declare -A LIMIT_NOTIFIED=()
declare -A HERMES_DOWN=()
declare -A HERMES_NOTIFIED=()
declare -A HERMES_RESTARTED=()
DOWN_AFTER="${WATCHDOG_HERMES_DOWN_AFTER:-3}"

log() { echo "$(date '+%F %T') $*" >>"$LOG" 2>/dev/null || true; }

confirm_startup() {
  local name="$1" i scr
  for i in $(seq 1 40); do
    sleep 2
    tmux has-session -t "$name" 2>/dev/null || return 0
    scr=$(tmux capture-pane -t "$name" -p 2>/dev/null)
    if echo "$scr" | grep -q "bypass permissions on"; then
      log "startup complete for $name"; return 0
    elif echo "$scr" | grep -q "Bypass Permissions mode"; then
      tmux send-keys -t "$name" Down; sleep 0.5; tmux send-keys -t "$name" Enter
      log "accepted bypass-permissions dialog for $name"
    elif echo "$scr" | grep -q "for local development"; then
      tmux send-keys -t "$name" Enter
      log "confirmed dev-channels dialog for $name"
    fi
  done
}

ensure() {
  local name="$1" dir="$2" now last
  tmux has-session -t "$name" 2>/dev/null && return 0

  now=$(date +%s)
  last=${LAST_RESTART[$name]:-0}
  if (( now - last < COOLDOWN )); then
    return 0
  fi
  LAST_RESTART[$name]=$now

  if [ -x "$dir/start.sh" ]; then
    tmux new-session -d -s "$name" -c "$dir" "./start.sh"
    confirm_startup "$name" &
    log "restarted $name (dir $dir)"
  else
    log "ERROR $name: no executable start.sh in $dir"
  fi
}

pulse() {
  local name="$1" now last pane_pid
  tmux has-session -t "$name" 2>/dev/null || return 0
  now=$(date +%s); last=${LAST_RESTART[$name]:-0}
  (( now - last < GRACE )) && return 0
  pane_pid=$(tmux list-panes -t "$name" -F '#{pane_pid}' 2>/dev/null | head -1)
  [ -n "$pane_pid" ] || return 0
  # До версии 2.1.252 мост в Telegram был отдельным процессом (bun server.ts),
  # начиная с неё он работает внутри самого claude. Признак живой связи —
  # любой из двух, иначе сторож убивал бы здорового агента каждую минуту.
  if ! pgrep -P "$pane_pid" -f "server.ts" >/dev/null 2>&1 \
     && ! ps -o args= -p "$pane_pid" 2>/dev/null | grep -q "dangerously-load-development-channels"; then
    log "NO PULSE for $name (Telegram bridge dead) — restarting"
    LAST_RESTART[$name]=$now
    tmux kill-session -t "$name" 2>/dev/null
  fi
}

sweep() {
  local name="$1" dir="$2" live_pid pid pcwd
  live_pid=$(tmux list-panes -t "$name" -F '#{pane_pid}' 2>/dev/null | head -1)
  [ -n "$live_pid" ] || return 0
  for pid in $(pgrep -f 'server:dashi-channel' 2>/dev/null); do
    [ "$pid" = "$live_pid" ] && continue
    pcwd=$(readlink "/proc/$pid/cwd" 2>/dev/null) || continue
    case "$pcwd" in
      "$dir"|"$dir"/*) kill "$pid" 2>/dev/null && log "swept orphan claude $pid for $name (cwd $pcwd)" ;;
    esac
  done
}

# Пишет владельцу напрямую от бота ЭТОГО агента (сам агент недоступен —
# писать должен кто-то другой). Токен и Telegram ID владельца берутся из
# secrets/channel.env агента — тех же, что и сам агент использует.
notify_owner() {
  local src="$1" msg="$2" env_file token uid
  # Обычный агент передаёт свою ПАПКУ (токен в secrets/channel.env), а
  # Hermes-профиль передаёт свой файл .env напрямую — раскладка своя, а
  # смысл тот же: токен бота и твой Telegram-id.
  if [ -f "$src" ]; then env_file="$src"; else env_file="$src/secrets/channel.env"; fi
  token=$(grep -m1 '^TELEGRAM_BOT_TOKEN=' "$env_file" 2>/dev/null | cut -d= -f2-)
  uid=$(grep -m1 -E '^TELEGRAM_ALLOWED_USER_IDS=|^TELEGRAM_ALLOWED_USERS=' "$env_file" 2>/dev/null | cut -d= -f2- | cut -d, -f1)
  if [ -z "$token" ] || [ -z "$uid" ]; then
    log "notify_owner: missing token/user id in $env_file"
    return 1
  fi
  curl -s -m 10 "https://api.telegram.org/bot${token}/sendMessage" \
    --data-urlencode "chat_id=${uid}" --data-urlencode "text=${msg}" >/dev/null
}

# check_hermes UNIT DIR WHO — для агента на Hermes: это не тмукс-сессия, а
# systemd-служба пользователя. Если она не "active" три проверки подряд —
# пробуем поднять сама (reset-failed нужен, если systemd уже сдался) и один
# раз пишем владельцу от бота ЭТОГО агента. Восстановление — молча, отдельное
# сообщение об этом было бы просто шумом.
check_hermes() {
  local unit="$1" dir="$2" who="$3" state
  state=$(systemctl --user is-active "$unit" 2>/dev/null)

  if [ "$state" = "active" ]; then
    HERMES_DOWN[$unit]=0
    HERMES_NOTIFIED[$unit]=""
    HERMES_RESTARTED[$unit]=""
    return 0
  fi

  HERMES_DOWN[$unit]=$(( ${HERMES_DOWN[$unit]:-0} + 1 ))
  [ "${HERMES_DOWN[$unit]}" -ge "$DOWN_AFTER" ] || return 0

  if [ -z "${HERMES_RESTARTED[$unit]:-}" ]; then
    HERMES_RESTARTED[$unit]=1
    systemctl --user reset-failed "$unit" 2>/dev/null
    systemctl --user restart "$unit" 2>/dev/null
    log "hermes unit $unit is ${state:-unknown} — tried to revive it"
  fi

  [ -n "${HERMES_NOTIFIED[$unit]:-}" ] && return 0
  notify_owner "$dir/.env" "${who}: я не работаю и не отвечаю в чате. Пробую подняться сама. Если через пару минут молчу — скажи тех-спецу." \
    && HERMES_NOTIFIED[$unit]=1
  log "hermes unit $unit is ${state:-unknown} — notified owner"
}

# Ловит момент "кончился лимит Claude" в две стадии.
#
# Стадия 1 — МЕНЮ. Реальный экран лимита — это не баннер, а интерактивное меню:
#     What do you want to do?
#   > 1. Stop and wait for limit to reset
#     2. Upgrade your plan
# Пока оно на экране, claude ждёт нажатия клавиши и НЕ продолжит сам, даже
# когда лимит освободится. Пункт 1 выбран по умолчанию, поэтому просто Enter
# отвечает на него правильно.
#
# Стадия 2 — уведомление с точным временем сброса.
check_limit() {
  local name="$1" dir="$2" pane reset_time msg menu=""
  tmux has-session -t "$name" 2>/dev/null || return 0
  pane=$(tmux capture-pane -t "$name" -p 2>/dev/null)

  if echo "$pane" | grep -qiF 'Stop and wait for limit to reset' \
     && echo "$pane" | grep -qiF 'Upgrade your plan' \
     && echo "$pane" | grep -qiF 'What do you want to do?'; then
    menu=1
    tmux send-keys -t "$name" Enter 2>/dev/null
    log "limit prompt answered for $name (chose: stop and wait for reset)"
  fi

  if echo "$pane" | grep -vE '\||grep' | grep -qiE 'usage limit reached|limit reached.*resets?'; then
    [ -n "${LIMIT_NOTIFIED[$name]:-}" ] && return 0
    reset_time=$(echo "$pane" | grep -oiE 'resets?[^0-9]{0,8}[0-9]{1,2}(:[0-9]{2})?\s*(am|pm)?' | tail -1 \
      | grep -oiE '[0-9]{1,2}(:[0-9]{2})?\s*(am|pm)?')
    if [ -n "$reset_time" ]; then
      msg="${name} сейчас недоступен — кончился лимит Claude, освободится примерно в ${reset_time}."
    else
      msg="${name} сейчас недоступен — кончился лимит Claude. Точное время на экране не разобрал."
    fi
    notify_owner "$dir" "$msg" && LIMIT_NOTIFIED[$name]=1
    log "usage-limit hit for $name (reset: ${reset_time:-unknown}), notified owner"
  elif [ -n "${LIMIT_NOTIFIED[$name]:-}" ] && [ -z "$menu" ]; then
    LIMIT_NOTIFIED[$name]=""
    tmux send-keys -t "$name" Enter 2>/dev/null
    log "usage-limit cleared for $name, nudged"
  fi
}

main() {
  log "watchdog started (pid $$)"
  while true; do
    for name in "${!AGENTS[@]}"; do
      ensure "$name" "${AGENTS[$name]}"
      sweep  "$name" "${AGENTS[$name]}"
      pulse  "$name"
      check_limit "$name" "${AGENTS[$name]}"
    done
    for unit in "${!HERMES[@]}"; do
      check_hermes "$unit" "${HERMES[$unit]}" "${HERMES_WHO[$unit]}"
    done
    sleep "$INTERVAL"
  done
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main
fi
