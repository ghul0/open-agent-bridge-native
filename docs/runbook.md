# Codzienna obsługa centralnego NAB

Runtime release **0.2.0-52c3dc2**. Jeden `codex-app-server.service`, jeden `nab-broker.service` i kliencki `nab-host.service`. Host adapter nie jest drugim brokerem. Szczegółowy lokalny runbook: `~/.local/state/native-agent-broker/runbook.md`.

## Codex — natywnie

```bash
codex
# albo istniejący skrót coy
```

W zweryfikowanym środowisku zwykłe TUI automatycznie dołącza do istniejącej centrali. NAB nie uruchamia Codexa ani App Servera. `oab-native launch codex` jest wyłączone i wyjaśnia użycie native CLI.

Nazwę nadajesz natywnie w TUI:

```text
/rename reviewer
```

NAB odczytuje thread.name; threadId pozostaje stałą tożsamością. Agent dostaje informację o nazwie, a bieżąca nazwa znajduje się też w metadata odbiorcy i self narzędzia list_agents. Niejednoznacznych nazw nie rozwiązuje się przez wybór pierwszej sesji.

Operator może użyć API bez wrappera:

```bash
oab-native codex status
oab-native codex rename THREAD_ID reviewer
codex resume THREAD_ID
```

`--name` nie jest flagą Codexa. Jawne `codex --remote unix://…` pozostaje natywnym sposobem wyboru serwera w diagnostyce; nie jest wymagane przez NAB. Niektóre flagi `-c`/profile lub niedostępność daemona mogą spowodować osobny embedded runtime — doctor raportuje duplikaty, nie zabija ich automatycznie.

## Pozostałe harnessy i usługi

```bash
oab-native launch claude --name claude-orchestrator --project "$PWD"
oab-native launch pi --name pi-researcher --project "$PWD"
oab-native service status
oab-native service start
oab-native service stop
oab-native service restart
oab-native doctor --json
```

NAB service polecenia dotyczą wyłącznie brokera i host adaptera. Centralny Codex jest niezależny:

```bash
systemctl --user status codex-app-server.service
```

Nie restartuj go podczas cudzych aktywnych tur bez uzgodnienia. TUI może wykonać reconnect, ale niepewne operacje nie są automatycznie ponawiane. `codex app-server proxy` używany przez SSH jest klientem centrali, nie dodatkowym runtime — nie zabijać go jako duplikatu.

## Narzędzia, historia i backup

Claude korzysta z prawdziwych ListAgents/SendMessage. Codex/Pi: list_agents/send_message, push przez runtime. Codex sender z `_meta.threadId`, nie pliku bindingu ani argumentu from.

```bash
oab-native agents --json
oab-native messages
oab-native messages --include-body
oab-native messages --agent AGENT_ID --include-body
oab-native backup --to "$HOME/.local/state/native-agent-broker/backup-new.sqlite"
oab-native capture status
```

Backup VACUUM INTO plus `.initialized`; cel musi nie istnieć. `accepted` nie oznacza odczytu, `runtime_accepted` wymaga receipt, `delivery_unknown` nie upoważnia do ślepego retry. Native odpowiedź Claude może nie mieć inReplyTo. Ruch bezpośredni Claude↔Claude nie jest przechwytywany.

## Setup i aktualizacja

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
node dist/native/cli.js setup --local --harnesses claude,codex,pi --release VERSION
oab-native codex configure
oab-native service install --user --start --manifest MANIFEST_PATH
```

`codex configure` minimalnie dodaje docelowy MCP do konfiguracji Codexa i wywołuje MCP reload bez restartu runtime. Parser wymaga Python3.11+ tomllib. Backup/hash manifest zachowuje pozostałe ustawienia i MCP. Nie kopiuje OAuth. Zmiany poza zarządzanym blokiem nie są nadpisywane. Gdy potrzebny restart centrali, wykonaj go świadomie oddzielnie.

Migracja starszych własnych adapterów po ich zatrzymaniu:

```bash
oab-native codex migrate-bindings --from codex:OLD_NAME
```

Zwrócony manifest służy do CAS rollback; nie migruj obcych endpointów. Szczegóły w rollback.md. Usługi nie wymagają sudo ani linger i nie inicjują zadań modeli przy starcie poza jawnymi powiadomieniami identity nowych/zmienionych sesji.

## E2E i drugi host

```bash
oab-native e2e --suite local-3 --tmux
```

Runner korzysta z centrali i prawdziwego TUI. `--approve-nab-tools` to wyłącznie jawna sesyjna zgoda operatora na dwa narzędzia NAB w testowym Codexie. Brak auth/approval/trace nie daje PASS. `--run-id`, `--resume`, `--keep-sessions` pozwalają diagnozować własne testy.

Drugi host: własny hostId, brokerUrl i lokalny adapter. Bez współdzielenia socketów czy udostępniania App Servera do Internetu; sieć/tunel stanowi granicę zaufania. Sprawdzono dwa logiczne hosty, nie dwie fizyczne maszyny. Antigravity i native capture poza MVP.
