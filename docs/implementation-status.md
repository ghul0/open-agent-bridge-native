# Status implementacji NAB

Profil odbioru: **LOCAL_3**. Status: **PARTIAL_LOCAL_3_RUNNING** — broker i trzy integracje działają, macierz funkcjonalna potwierdzona, ale nie wszystkie bramki operacyjne mają niezależne odtworzenie. Nie deklarujemy pełnego DONE.

| Ticket | Stan | Kod / test / dowód |
|---|---|---|
| T00 | DONE | environment-report.md; prywatny preflight. |
| T01 | DONE | fork z właściwym parent, upstream-lock.json, MIT notices; baseline 376 testów. |
| T02 | DONE_WITH_LIMITS | compatibility-matrix.md, native wire i realne Codex/Pi; normalny native receipt nieobecny, stan unknown. |
| T03 | DONE | architecture.md, src/native/contracts.ts, Zod i native-core.test.ts. |
| T04 | DONE | channel_endpoints + host/adapter/session identity; test many adapters/same cwd i realne diagonale. |
| T05 | DONE_CORE | ChannelStore: migrations/outbox/idempotency/TTL/unknown/retention, native-core.test.ts; backup VACUUM INTO, realny restart. Pełny fizyczny disk-full nie wykonany, fault injection zapisu wykonane. |
| T06 | DONE_CORE | HostLink + host adapters; reconnect i leases, core dwa logiczne hosty. |
| T07 | DONE_BASIC | claude-wire.ts + tests, rzeczywisty PID/procStart, half-close, native probe. Pełny zestaw control frames nieobsługiwany. |
| T08 | DONE_BASIC | claude-host/helper, realne odrębne projekcje Pi/Codex; cleanup własnych helpers sprawdzony. |
| T09 | DONE_BASIC | native roundtrips i hold/refuse PASS; bez capture oryginalnego Claude↔Claude. |
| T10 | DONE | mcp.ts / Pi tools, bound identity; send/list prawdziwych modeli. Zaufana sieć, brak auth NAB zgodnie zakresem. |
| T11 | DONE_CORE | codex-runtime/managed: exact TUI marker+thread, start/steer, raw event trace, approvals w TUI. Nieograniczona adopcja starych CLI poza zakresem. |
| T12 | DONE_CORE | clean Pi 0.85.1 + extension, idle/busy/reload/multi-turn i odrębne sessionId. |
| T13 | OUT_OF_MVP | Antigravity. |
| T14 | DONE_WITH_LIMITS | install.ts + 10 testów; realny setup/upgrade/systemd/smoke. Warianty XDG i rollback po każdej możliwej awarii instalacji niezweryfikowane. |
| T15 | DONE_BASIC | CLI doctor/agents/messages/capture/backup; realny doctor exit 0 po reconnect. |
| T16 | PARTIAL | e2e.ts + hardened evidence.ts, unit tests; pełny automatyczny runner nie odtworzony live po ostatnich poprawkach. |
| T17 | PASS_MANUAL_LIVE | 9 roundtripów: 6 cross + 3 diagonale; exact runtime evidence potwierdzone niezależnie oraz hardened oracle. |
| T18 | PASS_TARGETED | Codex/Pi busy, Pi 3 exchanges, same cwd i concurrent senders, brak broadcastu. Jeden dodatkowy retest promptu miał zbędny ACK; nie liczony jako PASS, historyczny poprawny scenariusz zachowany. |
| T19 | PARTIAL | deterministic fault/replay/storage/rate/lease tests, realny restart/hold/refuse. Pełne fizyczne awarie dysku i wszystkie kombinacje runtime crash nie wykonane. |
| T20 | OUT_OF_MVP | Capture pozostaje osobnym eksperymentem. |
| T21 | PASS_LOCAL_LOGICAL | dwa logiczne hosty oraz dwa adaptery tego samego hosta: routing/reconnect fixture WS, bez fizycznego rozproszenia. |
| T22 | OUT_OF_MVP | drugi rzeczywisty host. |
| T23 | PASS_SMOKE | release 0.1.0-6f5f41a, systemd --user active/enabled, trzy launchery z nowych powłok, realne odpowiedzi, restart+reconnect i backup. |
| T24 | PARTIAL | niezależny review kodu/dowodów wykonany, wykryte critical poprawione; pełne odtworzenie E2E od zera przez reviewera jeszcze nie wykonane. Draft PR, bez finalnego tag/merge. |

## Weryfikacja

Baseline 376 testów / 48 plików. Przed instalacją full build/lint exit 0 i 542 testy PASS / 62 pliki; liczenie zawiera źródła i skompilowane testy, nie tyle unikalnych scenariuszy. Kolejna poprawka ownership instalatora ma osobny test i 10/10 PASS. Wszystkie wcześniejsze nieudane próby zachowano w prywatnych dowodach i compatibility-matrix.md.

## Prywatne dowody

`~/.local/state/native-agent-broker/`: preflight-20260908, baseline, probes, e2e (structured-oracle.json, exact Codex threads, Pi JSONL, policy receipts, cleanup manifest), verification, release-smoke-messages.json, doctor.json, runbook.md. Instalacja i backupy poza repo. Żaden brakujący trace nie jest PASS.
