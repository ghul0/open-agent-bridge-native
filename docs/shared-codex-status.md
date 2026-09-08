# Migracja na centralny Codex

Status: **IMPLEMENTED_E2E_RUNNING**. Historyczne DONE_LOCAL_3 nie zastępuje odbioru tej architektury.

## Potwierdzone live

- Jedna istniejąca usługa codex-app-server.service, bez restartu w trakcie migracji. Dodatkowy historyczny runtime demo NAB zamknięty po sprawdzeniu właściciela i zachowaniu historii. Aktualny licznik:1 runtime +1 SSH proxy; Node launchers nie są liczone jako serwery.
- SSH app-server proxy jest klientem centrali, pozostał nietknięty.
- Dwa prawdziwe TUI Codexa bez wrappera, bez -c i bez --remote: ten sam cwd, różne native thread IDs. Jeden wątek utworzony przez API i po pierwszej trwałej turze dołączony natywnym resume, drugi utworzony zwykłym codex.
- Dwa rzeczywiste calls probe list_agents przekazały różne, poprawne extra._meta.threadId. Docelowe list_agents/send_message NAB wykorzystują metadata, nie binding file.
- Request approval widoczny w dodatkowym RPC subscriberze nie został przez niego rozstrzygnięty. Natywne TUI obsłużyło zgodę użytkownika; serverRequest/resolved potwierdzony.
- thread/name/set → thread/name/updated → roster/projekcja → deduplikowana wiadomość o własnej nazwie w kontekście modelu. Model odpowiedział swoją prawidłową nazwą.
- Native Claude→shared Codex→Claude oraz shared Codex→shared Codex→pierwotny thread działają z challenge. Pierwsza próba modelu podała nieprawidłowe argumenty MCP, potem błędnie skróciła challenge — zachowana jako FAIL. Nowy jednoznaczny test odczytu przeszedł, nie naprawiano odpowiedzi za model.

## Implementacja

CodexConnection (UDS WebSocket Hostlocalhost), CodexHost z jednym połączeniem i snapshotem loaded threads, synchronizacja natywnych nazw, approvals observer, start/steer, reconnect. MCP wymaga canonical threadId metadata i aktywnego endpointu. ChannelStore zapewnia transakcyjną migrację owner i identity+message, queue/rate limits. CLI odmawia wrapperowego launch codex; operator używa zwykłego codex i /rename. Osobne codex status/rename/configure/migrate-bindings nie uruchamiają serwera.

Konfiguracja dodawana minimalnym merge TOML z backupem/hashami. Temporary nab_shared_probe jest wyłączony do czasu zamknięcia dwóch probe threadów, ponieważ per-thread override wymaga obecności kompletnego transportu podczas MCP reload; po cleanup wpis zostanie usunięty. Docelowy server MCP pozostaje native_agent_broker.

## Odbiór w toku

Nowa macierz9 na centralnej usłudze i natywnych klientach, dodatkowe busy/name/reconnect, review, kontrolowany release, aktualizacja dokumentacji i shared reports. Nie deklarujemy pełnego PASS zanim te bramki się zakończą. Prywatne dowody: katalog stanu shared-migration i acceptance-final/sharedfinal.
