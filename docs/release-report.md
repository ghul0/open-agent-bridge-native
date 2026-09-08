# Raport końcowy centralnego Codexa

**DONE_LOCAL_3_SHARED_CODEX**, 2026-09-08. Runtime release **0.2.0-52c3dc2**, commit `52c3dc2`. Repo: https://github.com/ghul0/open-agent-bridge-native, PR: https://github.com/ghul0/open-agent-bridge-native/pull/1.

## Co zmieniono

- Usunięto launcher Codexa tworzący App Server per sesja. Codex/coy działają natywnie; istniejąca usługa centralna jest jedynym runtime.
- SSH app-server proxy zachowano jako klienta centrali. Doctor liczy runtime oddzielnie od proxy i Node launchera; końcowy wynik1 runtime +1 proxy.
- Jeden CodexHost obsługuje wiele loaded threads przez WebSocket-over-UDS. Brak polling narzędziem modelu i brak importu całej historii jako online.
- Narzędzia nadal tylko list_agents/send_message; nadawca z extra._meta.threadId i zweryfikowanego endpointu. Brak from od modelu i per-session binding file.
- Natywne thread.name, /rename, thread/name/set są źródłem nazw NAB. Model dostaje deduplikowane powiadomienie, a bieżąca nazwa jest w metadanych odbiorcy i self list_agents.
- Własność starego demo przeniesiono transakcyjnie do codex-central bez zmiany agentId/historii; stary dodatkowy runtime zamknięto po sprawdzeniu właściciela.

## Odbiór

**9/9 nowej macierzy live PASS**, wszystkie scenariusze pierwszym podejściem w tej macierzy. Odrębne wcześniejsze probe błędy zachowano. Niezależny reviewer potwierdził komplet ordered tool/result/input/read/reply dla właściwych sesji.

Dwa native TUI bez wrappera i --remote, jeden cwd, dwie tożsamości metadata; native Claude tools; busy same-turn steering; rename i wiedza modelu; durable identity dedup po reconnect; approvals widoczne w TUI przy biernym observerze adaptera. Centralny restart wykonano dopiero po jawnej zgodzie użytkownika; TUI odzyskał ten sam thread bez automatycznego resend.

**311 testów źródłowych / 39 plików PASS**, build, typecheck i lint PASS. Dotychczasowe storage/fault/rollback/native protocol testy pozostały. Dodano tests UDS Host header, multiplexing, metadata, nazw/state/reconcile, ownership CAS, identity transaction i config merge.

## Wdrożenie

`codex-app-server.service`, `nab-broker.service`, `nab-host.service` są active; usługi użytkownika enabled. Host NAB jest adapterem/klientem, nie drugim brokerem. Broker loopback4997. Finalny doctor exit0. Release poza checkout, docelowy MCP wskazuje jego plik. Po wdrożeniu realny reply z poprawnym challenge i aktualną nazwą wrócił do native Claude.

Tymczasowy probe MCP usunięto; oryginalne MCP zachowano. Późniejsze zmiany trust projektów nie zostały nadpisane. Zachowano manifesty/backups release, MCP i ownership. Cztery testowe Claude/Pi i testowy Codex z override zamknięto, pozostawiając jeden natywny Codex o nazwie `nab-codex-native` oraz wcześniejsze demonstracje Claude/Pi.

## Granice

Brak nowej flagi codex --name — użyj /rename lub oab-native codex rename. Pusty API-created thread bez trwałej tury może nie dawać się wznowić; nie obiecujemy takiego flow bez testu. Thread loaded nie jest dowodem widoczności w dowolnym TUI. Normalny native receipt bywa nieobecny — delivery_unknown pozostaje prawdziwym statusem.

Natywny Codex nie zapewnia globalnego zakazu wszystkich embedded/ws/stdio instancji; NAB ich nie tworzy, doctor je wykrywa. Nie zmodyfikowano binarki i nie instalowano wrappera. Sieć brokera jest zaufana, bez NAB auth/RBAC. Antigravity, fizyczny drugi host i transparentne native capture poza MVP.

Szczegółowe wyniki: shared-codex-status.md. Użycie: runbook.md; cofnięcie: rollback.md. Prywatne trace/bazy/auth nie trafiają na GitHub.
