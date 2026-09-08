# Status implementacji NAB

**Aktualny zakres: IN_PROGRESS_SHARED_CODEX.** Nadrzędna korekta w SCOPE_SHARED_CODEX.md; postęp w shared-codex-status.md. Poniższy DONE jest historycznym odbiorem wariantu per-session App Server, nie zaliczeniem nowej architektury.

**DONE_LOCAL_3 — odbiór zakończony 2026-09-08.** Obowiązuje SCOPE_LOCAL_3.md, nie historyczny LOCAL_4. Runtime release **0.1.0-9066780**, commit `9066780`. Końcowe dowody: acceptance-final.md; niepowodzenia wcześniejszych prób zachowano.

| Ticket | Stan LOCAL_3 | Kod / test / dowód |
|---|---|---|
| T00 | DONE | environment-report.md, prywatny preflight |
| T01 | DONE | właściwy fork, upstream-lock.json, MIT notices, baseline |
| T02 | DONE | realne native Claude, same-thread Codex i czyste Pi; compatibility-matrix.md |
| T03 | DONE | architecture.md, contracts.ts, Zod, native-core.test.ts |
| T04 | DONE | host/adapter/nativeSession identity, snapshot reconnect, realne diagonale we wspólnym cwd |
| T05 | DONE | ChannelStore migrations/outbox/idempotency/TTL/unknown/retention, real SQLITE_FULL/readonly/missing DB, WAL backup |
| T06 | DONE | HostLink, leases, runtime adapters, dwa logiczne hosty i cleanup |
| T07 | DONE_BASIC | claude-wire.ts, parser/half-close, real PID/procStart, normal receipt ograniczony |
| T08 | DONE | odrębne helpers/projekcje, live discovery, cleanup manifest i brak reimportu projekcji |
| T09 | DONE_BASIC | native roundtrips, rzeczywiste hold/refuse, brak ingerencji w native Claude↔Claude |
| T10 | DONE | wspólne list_agents/send_message, identity binding; bez auth NAB zgodnie aktualizacją zakresu |
| T11 | DONE | managed Codex App Server/TUI, exact threadId, start/steer, expectedTurnId, realny shutdown bez orphanów |
| T12 | DONE | clean Pi 0.85.1, extension idle/busy/reload/multi-turn, niezależne sesje |
| T13 | OUT_OF_MVP | Antigravity |
| T14 | DONE | setup/upgrade/rollback, manifest hashes, izolowane i rzeczywiste instalacje; globalne konfiguracje zachowane |
| T15 | DONE | doctor/agents/messages/capture/backup; finalny doctor exit 0 |
| T16 | DONE | automatyczny live runner, bounded retries i strukturalny oracle; finalne 9 scenariuszy PASS po udokumentowanym retest |
| T17 | PASS_LIVE | 6 kierunków cross-harness + Codex/Pi diagonal + native Claude control, niezależnie sprawdzone |
| T18 | PASS_LIVE | busy Codex/Pi, trzy wymiany w tej samej sesji, same cwd i izolacja rozmów; brak automatycznego relay outputu |
| T19 | DONE | native-core/native-acceptance/managed-processes tests, realne full/readonly/missing DB, ACK loss, leases, queue/rate/TTL, actual Codex lifecycle |
| T20 | OUT_OF_MVP | capture osobno, natywny tor pozostaje nietknięty |
| T21 | PASS_LOCAL_LOGICAL | dwa logiczne hosty i wiele adapterów jednego hosta; routing/reconnect, nie test fizycznego rozproszenia |
| T22 | OUT_OF_MVP | druga rzeczywista maszyna |
| T23 | DONE | release poza checkout, systemd --user active/enabled, restart/reconnect, smoke odpowiedzi i backup |
| T24 | DONE | niezależny review nowego replay 9/9 i fault acceptance; poprawki regresyjne, finalne raporty i PR we własnym forku |

## Końcowa weryfikacja

**283 unikalne testy źródłowe / 33 pliki PASS**, build/typecheck/lint PASS. `vitest.config.ts` wyklucza wyłącznie skompilowane kopie z dist, nie źródłowe testy. Wcześniejsze liczby 542 obejmowały podwójne źródła/build. Nowe testy pełnego SQLite i subprocess nie zastępują live E2E — są osobną warstwą.

Macierz odbioru obejmuje 8 PASS w sekwencji i 1 PASS w retest po zgodzie native tools Claude, na tych samych session IDs. Wcześniejszego FAIL nie zmieniono na PASS; osobny acceptance-matrix.json wskazuje końcowe zweryfikowane próby. Reviewer potwierdził autentyczne tool calls, odczyty challenge i powrotne peer inputy. Odpowiedzi busy i pamięć 29 → 88 → recall potwierdzono dodatkowo.

## Granice

Nie gwarantujemy wszystkich przyszłych wersji CLI ani odpowiedzi modelu na dowolny prompt. Native basic messaging jest obsługiwane; pełne control operations (np. notice idle) i transparentne capture nie są deklarowane. Normalny native socket write bez receipt pozostaje delivery_unknown; nie udajemy read i nie zgadujemy native inReplyTo. Dostęp do sieci brokera oznacza zaufanie; brak izolacji nieufnych użytkowników.

Fizyczna awaria nośnika/bit corruption nie była odtwarzana: sprawdzono realny SQLITE_FULL, prawa filesystemu, usunięcie pliku i odtworzenie backupu. Antigravity i drugi fizyczny host nie są blokadą LOCAL_3.

Prywatne dowody oraz manifesty pozostają w katalogu stanu `native-agent-broker/acceptance-final`; lokalny runbook w `~/.local/state/native-agent-broker/runbook.md`.
