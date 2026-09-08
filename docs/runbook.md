# Codzienna obsługa LOCAL_3

Bieżący runtime release: **0.1.0-6f5f41a**. Instalacja lokalna została uruchomiona i przetestowana. Szczegółowy runbook z prywatnymi ścieżkami: `~/.local/state/native-agent-broker/runbook.md`. Status pełnego odbioru w implementation-status.md.

## Start i diagnostyka

```bash
oab-native service start
oab-native service stop
oab-native service restart
oab-native service status
oab-native doctor --json
oab-native agents --json
```

systemd --user: `nab-broker.service`, `nab-host.service`; restart z backoffem i start przy uruchomieniu menedżera usług użytkownika. Nie włączano linger. Usługi nie inicjują zadań modeli. Po restarcie odczekaj na reconnect; doctor zgłasza brak wymaganej sesji, a nie udaje gotowości.

## Sesje

```bash
oab-native launch claude --name claude-orchestrator --project "$PWD"
oab-native launch codex --name codex-reviewer --project "$PWD"
oab-native launch pi --name pi-researcher --project "$PWD"
```

Claude używa natywnych ListAgents/SendMessage. Codex i Pi używają list_agents/send_message; odbiór nie wymaga pollingu przez model. Codex launcher uruchamia osobny App Server i remote TUI tego samego threadId. Krótki modelowy marker potwierdza attach, a dopiero potem endpoint trafia do rosteru. Własne MCP i autoryzacje użytkownika pozostają, a narzędzia NAB wymagają normalnych zgód harnessu.

Pi jest czystą izolowaną instalacją 0.85.1. Globalne custom Pi i rozszerzenia nie są usuwane. Nowe sesje nie dostają automatycznej zgody na zadania od peerów: obowiązują ich instrukcje i uprawnienia.

## Historia i backup

```bash
oab-native messages
oab-native messages --follow
oab-native messages --include-body
oab-native messages --agent AGENT_ID --include-body
oab-native backup --to "$HOME/.local/state/native-agent-broker/backup-new.sqlite"
oab-native capture status
```

Domyślnie bez treści. Backup używa VACUUM INTO, nie kopii aktywnego pliku WAL; cel musi nie istnieć. Zachowaj plik `.initialized` razem z backupem. Utrata znanej bazy zatrzymuje przyjęcia zamiast tworzyć pozornie poprawną pustą historię.

`accepted` nie znaczy model response. `runtime_accepted` wymaga runtime evidence, `held` oznacza politykę odbiorcy, `responded` skorelowaną wiadomość. `delivery_unknown` nie upoważnia do ślepego resend; normalny native Claude nie zawsze zwraca receipt. Native odpowiedź może nie mieć inReplyTo. Capture obejmuje tylko ruch przez NAB.

## Instalacja i aktualizacja

W zweryfikowanym checkout:

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
node dist/native/cli.js setup --local --harnesses claude,codex,pi --release VERSION
node dist/native/cli.js service install --user --start --manifest MANIFEST_PATH
```

Wartości VERSION i MANIFEST_PATH odnoszą się do sprawdzanego release; setup wypisuje rzeczywisty manifest. Opcja `--release` celowo nie nazywa się `--version`, bo ta wyświetla wersję CLI. `NAB_BROKER_URL` może wskazać wybrany wolny port; instalator nie zatrzymuje obcej usługi.

Release jest samowystarczalny poza checkout. Manifest ownership, hashe i backupy chronią istniejące oraz późniejsze zmiany. Poprzedni release pozostaje dostępny. Rollback i uninstall opisano w rollback.md.

## E2E i drugi host

```bash
oab-native e2e --suite local-3 --tmux
```

Oddzielny namespace, ograniczone próby i prawdziwe runtime evidence. Brak logowania, approval albo trace daje BLOCKED/NOT_RUN. Sam automatyczny runner po końcowym review nie ma jeszcze niezależnego pełnego live replay; macierz integratora została wykonana i sprawdzona osobno.

Drugi host: ten sam release, własny stabilny hostId i brokerUrl, kontrolowana sieć/tunel. Uruchamia tylko lokalny adapter (`oab-native host`) oraz swoje launchery; centralny broker nie korzysta z jego filesystemu. Sieć jest granicą zaufania — brak auth NAB. Nie udostępniaj App Serverów/socketów. Dwa logiczne hosty przetestowano lokalnie, nie deklarujemy dwóch rzeczywistych maszyn.
