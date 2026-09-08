# Odbiór centralnego Codexa

**DONE_LOCAL_3_SHARED_CODEX**, 2026-09-08. Runtime release **0.2.0-52c3dc2**, commit `52c3dc2`. Zastępuje historyczny wariant per-session App Server.

## Potwierdzone live

- Jeden runtime `codex-app-server.service`; historyczny dodatkowy App Server NAB zamknięty po sprawdzeniu własności. SSH proxy pozostało klientem centrali. Doctor: runtimeCount=1, proxyCount=1, exit0.
- Dwa prawdziwe TUI Codexa bez wrappera, -c i --remote, ten sam cwd i różne thread IDs. Jeden testowy wątek utworzono przez API, po pierwszej trwałej turze dołączono natywne resume. Drugi powstał przez zwykły codex.
- Rzeczywiste modelowe calls przekazują odmienne extra._meta.threadId. Docelowe list_agents/send_message identyfikują nadawcę wyłącznie z metadata i rosteru, nie pliku bindingu lub argumentu from.
- Dodatkowy subscriber obserwował mcpServer/elicitation/request bez odpowiedzi; natywne TUI obsłużyło zgodę użytkownika, a serverRequest/resolved zakończyło oczekiwanie. Nie automatyzowano approval narzędzi shellowych.
- Natywne API rename oraz /rename propagują nazwę do rosteru/projekcji, zachowując threadId. Model otrzymuje deduplikowane powiadomienie; current recipient name dodatkowo w metadanych wejścia. Model poprawnie odpowiedział aktualną nazwą po retest.
- **9/9 nowej macierzy E2E PASS, każdy scenariusz w pierwszej próbie tej macierzy**: sześć kierunków cross-harness + Codex/Pi diagonal + native Claude control. Niezależny reviewer potwierdził exact session participants, successful calls, read challenge i return input. Wcześniejsze osobne probe failures zachowane.
- Busy Codex: w tym samym turnie wejście TEST, read challenge, completed send_message, pierwotne zadanie BUSY_SHARED_FINISHED; brak nowego hidden thread.
- Po kontrolowanym restarcie centrali za jawną zgodą użytkownika native TUI wykonał reconnect bez ponowienia inputu. Ten sam thread ID wrócił na loaded/list. Po wdrożeniu finalnego NAB nowy smoke reply dotarł do Claude z poprawnym challenge i nazwą.
- Name notifications: jedna dla pierwszego wątku; dla drugiego tylko przy faktycznych zmianach nazwy. Reconnect adaptera nie dublował powiadomień.

## Weryfikacja kodu i migracji

**311 testów źródłowych / 39 plików PASS**, build/typecheck/lint PASS. Reconcile serializowany; metadata missing/wrong/offline fail closed; migracja owner używa produkcyjnego klucza [hostId,adapterId], zachowuje historię i ma CAS rollback. Identity+queued message są atomowe z queue/rate limitami. Jeden RegistryServer i jedna SQLite — bez drugiego brokera.

Tymczasowy probe MCP został usunięty. Trzy dotychczasowe MCP pozostały bez zmian; dodano tylko native_agent_broker. Późniejsze zmiany ustawień zaufania projektów, wykonane równolegle przez harness, zachowano. Probe per-thread overrides wymagały restartu centrali, aby usunąć cache konfiguracji; restart wykonano dopiero po zgodzie człowieka.

## Zachowane niepowodzenia

- Pusty API thread/start→name/set→disconnect bez trwałej tury: resume odmówiło no rollout found. Nie ukryto tego dodatkowym wątkiem.
- NDJSON do proxy nie działa, ponieważ control socket wymaga WebSocket framing. Klient ws wymaga też Host:localhost; poprawny handshake i RPC potwierdzone.
- Pierwszy modelowy reply użył złych argumentów, a następnie skrócił challenge. To FAIL testu challenge, nie PASS. Nowa jednoznaczna próba read/reply przeszła.
- Jedna odpowiedź modelu przypomniała starą nazwę mimo powiadomienia. Dodano current name do routing metadata/self; retest bieżącej nazwy przeszedł.

## Granice

Loaded oznacza sesję załadowaną w runtime, nie gwarancję konkretnego widoku TUI. Broker nie przejmuje historii i nie tworzy modeli do discovery. Nie gwarantuje odpowiedzi modelu na dowolny prompt. Native Claude nie zawsze daje receipt — wtedy delivery_unknown. Globalne zablokowanie dowolnego embedded/ws/stdio Codex nie jest funkcją natywnego CLI; NAB nie tworzy duplikatów i doctor je wykrywa. Antigravity, fizyczny drugi host i native capture poza MVP.

Prywatne dowody: shared-migration/final-e2e.json, live-gates.json, mcp-meta-probe.jsonl, thread-a-final.json, thread-b-final.json, identity-dedup-evidence.json i acceptance-final/sharedfinal/*verified.json w katalogu stanu NAB. Nie trafiają do publicznego repo.
