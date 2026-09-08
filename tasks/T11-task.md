# T11 — Codex managed TUI oraz start/steer

Stan początkowy: PENDING. Aktualny stan: docs/implementation-status.md.

Nadrzędne zmiany: docs/SCOPE_LOCAL_3.md. LOCAL_4 → LOCAL_3; Antigravity, capture i fizyczne rozproszenie poza MVP. Auth NAB/RBAC usunięte z zakresu; poprawny routing i zabezpieczenia harnessów pozostają.

## Treść bazowa (stosuj z aktualizacją zakresu)

T11 — Codex managed TUI oraz start/steer

Cel: komunikaty trafiają do wątku, który użytkownik widzi.

Wykonaj: launcher App Server/TUI, trwały binding wątku, MCP tożsamość, ścieżkę idle i busy, wyścigi turnów, event subscription, reconnect i poprawne przekazywanie approval. Usuń niejednoznaczne „current thread = ostatni wykryty” oraz dublowanie auto-reply.

Dostarcz: adapter Codexa, testy kontraktowe i prawdziwe testy TUI.

Akceptacja: dwa Codexy w jednym katalogu nie mieszają kontekstu; aktywny Codex dostaje steer z poprawnym turn ID; nowy hidden thread nie jest używany do pozornego zaliczenia; nieznane żądanie App Servera nie dostaje domyślnej zgody.
