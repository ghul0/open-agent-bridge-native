# Raport końcowy LOCAL_3

**DONE_LOCAL_3.** Odbiór zakończony 2026-09-08. Wdrożony runtime commit **9066780**, release **0.1.0-9066780**. Repozytorium: https://github.com/ghul0/open-agent-bridge-native; PR: https://github.com/ghul0/open-agent-bridge-native/pull/1.

## Wynik

- Jeden istniejący RegistryServer i ChannelStore SQLite rozbudowany o native profile, trwały outbox, statusy, kolejkę, TTL, idempotencję i routing do przypisanego adaptera.
- Claude używa prawdziwych ListAgents/SendMessage; Codex ma kontrolowany App Server i ten sam widoczny TUI/thread; Pi 0.85.1 działa jako czysta izolowana instalacja z extension.
- **9/9 scenariuszy live PASS**: sześć cross-harness, Codex↔Codex, Pi↔Pi i kontrola native Claude↔Claude. Automatyczny replay zakończył 8 scenariuszy; jeden blokowany przez native classifier powtórzono po jawnej zgodzie użytkownika w tej samej sesji. Wszystkie końcowe próby przeszły rygorystyczny oracle i niezależny review.
- Busy Codex `turn/steer` z expectedTurnId = turnId, busy Pi, odczyt nieznanego challenge oraz rzeczywiste odpowiedzi. Dodatkowo trzy wymiany pamięci 29 → 88 → recall na tym samym Pi sessionId.
- Rzeczywisty shutdown testowego Codexa zamknął wszystkie jego procesy, a sąsiedni Codex pozostał aktywny. Po zakończeniu odbioru zamknięto wyłącznie własny namespace testowy i sprawdzono brak orphanów.
- **283 unikalne testy źródłowe / 33 pliki PASS**; build, typecheck i lint PASS. Skopiowane testy dist nie są ponownie liczone.
- Realne SQLITE_FULL, readonly permissions, brak DB z markerem, przerwany/obcy ACK, replay/lease/FIFO/TTL/rate-limit oraz odtworzenie backupu. Dwa logiczne hosty testowane lokalnie.

## Wdrożenie

Dwie usługi `nab-broker.service` i `nab-host.service` są **active/enabled** w systemd --user. Broker nasłuchuje na loopback, `doctor --json` kończy się sukcesem. Release leży poza checkout. Po aktualizacji usług rzeczywiste sesje odzyskały połączenie, a Codex i Pi odpowiedziały na nowe wyzwanie przez native Claude. Backup VACUUM INTO wykonano na działającej bazie.

Pozostawiono trzy bezczynne demonstracje w prywatnym tmux `nab-local3`, okna `demo-claude`, `demo-codex`, `demo-pi`. Nie pozostawiono pętli agentów. Lokalny runbook i manifesty są poza repo; wersja publiczna w runbook.md / rollback.md.

## Zachowane ograniczenia

- Native normalny write nie gwarantuje receipt; `delivery_unknown` jest uczciwym statusem nawet gdy model później odpowie. Nie deklarujemy read i nie zgadujemy inReplyTo natywnej odpowiedzi.
- Narzędzia nadal stosują uprawnienia harnessu. Zgody testowe nie oznaczają globalnego allow. Automatyczny runner bez zgody może zwrócić BLOCKED; `--approve-nab-tools` jest jawnym opt-in operatora tylko dla dwóch narzędzi w utworzonych sesjach Codexa.
- Exact attach marker Codexa może nie zostać poprawnie odtworzony przez model; launcher wtedy nie rejestruje pozornej gotowości. Wymaga świadomego retestu, nie poluzowania gate.
- Nie gwarantujemy przyszłych wersji CLI, fizycznej awarii nośnika ani działania w nieufnej sieci. Dostęp do sieci brokera oznacza zaufanie; brak auth NAB/RBAC zgodnie zakresem.
- Antigravity, rzeczywiste wdrożenie między maszynami i transparentne native capture są poza MVP. Nie wszystkie kontrolne ramki Claude (np. idle subscription) są emulowane.

Pełny przebieg i nieudane wcześniejsze próby: acceptance-final.md, acceptance-faults.md, compatibility-matrix.md. Prywatne transkrypcje, credentials, bazy i konfiguracje nie są publikowane.
