# Nadrzędna aktualizacja: centralny Codex

Zatwierdzony plan 2026-09-08 zastępuje sprzeczne postanowienia LOCAL_3 o App Serverze i launcherze per sesja.

- Jeden istniejący `codex-app-server.service` dla środowiska, jeden broker NAB i jedna SQLite. Host adapter nie jest drugim brokerem.
- Natywny Codex, bez wrappera i bez dodatkowego App Servera. Zwykły TUI może korzystać z implicit daemon reuse; jawne --remote jest opcją diagnostyczną, nie wymaganiem NAB.
- SSH `codex app-server proxy` jest klientem centrali; nie zatrzymywać go jako duplikatu runtime. Proces Node uruchamiający binarkę też nie jest osobnym runtime.
- Natywne thread.name / /rename / thread/name/set jako źródło nazwy. ThreadId to niezmienna tożsamość. Model otrzymuje osobne, deduplikowane powiadomienie o własnej nazwie.
- Pozostają wyłącznie dwa narzędzia agentów: list_agents i send_message. Nadawca Codexa wynika z metadanych bieżącego wywołania _meta.threadId, nie argumentu modelu ani współdzielonego pliku.
- Adapter centrali: jeden klient RPC WebSocket-over-UDS, mapa wątków, subskrypcje, reconcile i start/steer. Sam loaded thread nie dowodzi, że konkretny TUI go wyświetla.
- Zabezpieczenia approvals i native Claude zostają. Nie przejmować zgód przez odpowiadanie pustym result ani odrzucać każdego znanego approval, jeśli właściwe TUI powinno je obsłużyć.
- Usunąć własne per-session App Servery po bezpiecznej migracji. Nie zabijać nieznanych procesów ani aktywnej pracy w celu spełnienia licznika.
- Twardy globalny zakaz embedded/ws/stdio runtime nie jest gwarantowany przez Codex0.153.4. Doctor rozróżnia role i raportuje duplikaty; brak autokill.

Status: IN_PROGRESS_SHARED_CODEX. Dawny DONE_LOCAL_3 pozostaje historycznym odbiorem starego wariantu. Nowe bramki: dwa zwykłe TUI na jednej centrali, live meta identity, rename/model identity, events/approvals, idle/busy,9 kierunków, reconnect, rollback i niezależny review.
