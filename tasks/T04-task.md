# T04 — Wielosesyjny registry

Stan początkowy: PENDING. Aktualny stan: docs/implementation-status.md.

Nadrzędne zmiany: docs/SCOPE_LOCAL_3.md. LOCAL_4 → LOCAL_3; Antigravity, capture i fizyczne rozproszenie poza MVP. Auth NAB/RBAC usunięte z zakresu; poprawny routing i zabezpieczenia harnessów pozostają.

## Treść bazowa (stosuj z aktualizacją zakresu)

T04 — Wielosesyjny registry

Cel: dwa agenty tego samego rodzaju nie eliminują się nawzajem.

Wykonaj: usuń lub popraw heurystyki deduplikacji typu klient+projekt. Wprowadź ID sesji, instancję, binding techniczny, stabilne nazwy i jawny stan osiągalności. Uporządkuj reconnect oraz paginację listowania.

Dostarcz: migracja danych i testy registry.

Akceptacja: dwie sesje tego samego harnessu w identycznym cwd współistnieją; reconnect jednej nie zamyka drugiej; klient nie może przejąć cudzej tożsamości samym identify; historia nie pojawia się jako live.
