# ADR: centralny Codex, bez wrappera

Status: zatwierdzony kierunek, live gate w toku. Zastępuje serwer per sesja z historycznej architektury.

Jedyny runtime uruchamia istniejąca usługa codex-app-server.service. NAB jest klientem tego runtime, nie właścicielem TUI/processów. Natywne klienty mogą mieć wiele procesów proxy; nie oznacza to wielu serwerów. Jeden broker i SQLite pozostają.

Transport UDS jest WebSocket z HTTP Upgrade. Biblioteka ws wymaga ws+unix oraz Host:localhost, zgodnie walidacją centrali. NDJSON do app-server proxy nie jest właściwym framingiem.

Tożsamość: hostId+threadId → nativeAgentId; nazwa pochodzi z thread.name. MCP używa request extra._meta.threadId; brak metadanych lub nieznany thread daje błąd. Nie wracamy do najnowszego wątku/cwd/binding.json.

Approval: thread/resume zapisuje dodatkowego subscribera i replayuje pending requests. Pierwsza odpowiedź na server request wygrywa; adapter NAB ma obserwować rozpoznane approvals i nie odpowiadać, aby natywne TUI obsłużyło zgodę. Brak TUI/operatora jest stanem wymagającym uwagi, nie domyślną zgodą. Unknown requests nie stanowią pretekstu do null result.

Sesja utworzona API bez trwałego turnu może nie mieć rollout do późniejszego TUI resume. Rejestracja stale/unloaded historii jako online jest zabroniona. Rozróżniamy załadowanie runtime i obecność konkretnego TUI; tę drugą potwierdzają osobne testy, nie field status.

NAB powiadamia model o tożsamości raz przy pierwszej rejestracji/natywnej zmianie nazwy, przez dozwolone wejście runtime, z dedup przeżywającym reconnect. Nie dodajemy trzeciego narzędzia modelowego ani własnego systemu nazw konkurującego z /rename.
