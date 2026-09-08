# T13 — Antigravity push do właściwej konwersacji

Stan początkowy: OUT_OF_MVP. Aktualny stan: docs/implementation-status.md.

Nadrzędne zmiany: docs/SCOPE_LOCAL_3.md. LOCAL_4 → LOCAL_3; Antigravity, capture i fizyczne rozproszenie poza MVP. Auth NAB/RBAC usunięte z zakresu; poprawny routing i zabezpieczenia harnessów pozostają.

## Treść bazowa (stosuj z aktualizacją zakresu)

T13 — Antigravity push do właściwej konwersacji

Cel: rzeczywisty Antigravity odbiera bez ręcznego pobudzania.

Wykonaj: zgodny z lokalnym produktem binding procesu/konwersacji, dwa narzędzia MCP, eventowy odbiór, durable dedup oraz raport busy semantics. Popraw wybór „najnowszego” endpointu i czasowe heurystyki reiniekcji.

Dostarcz: adapter, testy wielu konwersacji, trace runtime.

Akceptacja: idle budzi się sam; odbiorca jest dokładnie tym widocznym w TUI; nie użyto Gemini CLI jako zamiennika, wpisywania wiadomości klawiszami ani cyklicznych „ok”. Brak tej możliwości blokuje LOCAL_4 i musi być wykazany.
