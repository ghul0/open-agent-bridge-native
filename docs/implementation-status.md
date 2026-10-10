# Status implementacji NAB

## Odrzucone wiadomości NAB — 2026-10-10 (lokalnie, bez wdrożenia)

- HTTP `/native/messages`: oversized zwraca 413, `code=text_too_large`, `limit_bytes=262144`, rzeczywisty `actual_bytes` UTF-8 i precyzyjny komunikat. Inny niepoprawny payload zwraca 400 / `invalid_payload`. Oryginalna treść nie trafia do outboxu.
- Dla aktywnej, zarejestrowanej sesji źródłowej i jednoznacznego znanego celu broker zapisuje techniczną notę systemową, nie wypowiedź źródła. Allowlist metadanych: kanoniczne source/recipient ID (ASCII, max 256 znaków), harness, stały powód, limit i rozmiar przy oversized. Brak treści, displayName, conversation_id, in_reply_to i dowolnych pól wejścia.
- `notification=queued` oznacza zapis w outboxie, nie potwierdzenie odbioru; `deduplicated` istniejącą notę, `skipped` brak bezpiecznej tożsamości/celu, `failed` niemożność zapisu (w tym rate limit/pełna kolejka). Błąd noty lub dispatch nie maskuje błędu nadawcy. Offline: queue / TTL 600 s; zwykłe receipts i statusy pokazują rzeczywisty wynik dostarczenia.
- Antyspam: istniejący trwały limit 30 nowych wiadomości/min dla pary recipient→recipient ogranicza **łącznie** noty do odbiorcy, także od wielu źródeł; limit kolejki 100 pozostaje. Noty nie żądają odpowiedzi, nie uruchamiają rekurencyjnych zgłoszeń. Dedupe w SQLite: hash źródła, celu i idempotency_key; bez klucza hash całego wejścia. Do bazy trafia wyłącznie hash, nie złe wejście. Dedupe obowiązuje przez istniejącą retencję ledgeru (30 dni), także po restarcie; późniejszy zmieniony request z tym samym kluczem nie tworzy kolejnej noty.
- Pi: lokalny limit tekstu i schema maxLength usunięte, walidacja bajtów jest brokerowa **po** dotychczasowej kontroli widoczności celu. Nieuprawniony cel nie dociera do brokera ani nie otrzymuje noty. Wake/retry tylko przy 409 „Recipient offline”, ze stałym operation ID; 400/413/429 nie budzą ani nie ponawiają wysyłki.
- Granica zaufania pozostaje bez zmian: NAB nie ma kryptograficznego uwierzytelnienia, RBAC ani brokerowej allowlisty. Tożsamość HTTP pochodzi z nagłówka `x-nab-agent-id` odpowiadającego aktywnej sesji z bindingiem adaptera, **nie** z payloadu. Nie jest to dowód authenticated identity; uczestnicy sieci pozostają zaufani i mogą podszyć się przez nagłówek. Allowlista Pi jest lokalna, nie chroni bezpośredniego HTTP. Wymaganie izolacji nieufnych klientów wymaga osobnego rozszerzenia auth, poza tym zakresem.
- Granice parserów: body HTTP >2 MiB otrzymuje 413 z opisem limitu JSON; błędny JSON otrzymuje 400. Bez parsowalnego payloadu brak bezpiecznego celu i brak noty; rozmiar text UTF-8 jest nieznany. WS/native obsługuje register/heartbeat/receipt, **nie** wysyłkę wiadomości; nieznana/błędna ramka zwraca native.error bez noty. Frame >2 MiB odrzuca transport WS przed parsowaniem. Błędne wywołanie odrzucone przez schema harnessu przed adapterem również nie dociera do brokera.
- Evidence: `src/registry/native-core.test.ts` (ASCII/UTF-8, metadane, malformed, target/source, dedupe, offline, awaria zapisu, rate limit, parser HTTP, WS), `src/native/pi-nab-extension.test.ts` (forward oversized, unauthorized, brak retry 413). Build i lint PASS (lint z istniejącymi ostrzeżeniami); Pełny zestaw: 354 testy / 41 plików PASS. Bez live E2E, push, restartu ani zmiany wdrożenia. Poprzedni limit commit `d4f63a7` i ta zmiana wymagają późniejszego wdrożenia.


**Aktualny odbiór: DONE_LOCAL_3_SHARED_CODEX.** Release `0.2.0-52c3dc2`, runtime commit `52c3dc2`. Jeden centralny App Server, jeden NAB; natywny Codex bez wrappera i bez obowiązkowego --remote. Nowe 9/9 E2E PASS potwierdzone niezależnie, 311 testów źródłowych / 39 plików PASS, build/typecheck/lint PASS. Thread names, metadata sender, approvals, busy, reconnect i finalny smoke sprawdzone. Szczegóły w shared-codex-status.md i SCOPE_SHARED_CODEX.md.

Poniższa tabela jest zachowanym historycznym odbiorem wariantu per-session. T07–T12/T14–T19/T23–T24 dla nowej architektury uzupełnia powyższy raport migracji; historycznych PASS nie przeniesiono automatycznie.

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
