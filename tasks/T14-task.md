# T14 — Setup i launchery bez niszczenia konfiguracji

Stan początkowy: PENDING. Aktualny stan: docs/implementation-status.md.

Nadrzędne zmiany: docs/SCOPE_LOCAL_3.md. LOCAL_4 → LOCAL_3; Antigravity, capture i fizyczne rozproszenie poza MVP. Auth NAB/RBAC usunięte z zakresu; poprawny routing i zabezpieczenia harnessów pozostają.

## Treść bazowa (stosuj z aktualizacją zakresu)

T14 — Setup i launchery bez niszczenia konfiguracji

Cel: użytkownik nie musi ręcznie sklejać usług.

Wykonaj: setup, profile, launchery, wybór wolnych portów, instalację rozszerzenia/MCP, wykrycie konfliktów i manifest zmian. Zachowaj źródła prawdy istniejącej synchronizacji konfiguracji.

Dostarcz: działające oab-native launch ..., idempotentny setup i testy merge/rollback.

Akceptacja: ponowna instalacja nie dubluje wpisów; zachowane są dotychczasowe MCP i routing; wszystkie launchery używają właściwych binarek i sesji; produkcja nie zależy od tymczasowego worktree.
