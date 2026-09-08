# T08 — Projekcja rosteru do natywnych peerów Claude

Stan początkowy: PENDING. Aktualny stan: docs/implementation-status.md.

Nadrzędne zmiany: docs/SCOPE_LOCAL_3.md. LOCAL_4 → LOCAL_3; Antigravity, capture i fizyczne rozproszenie poza MVP. Auth NAB/RBAC usunięte z zakresu; poprawny routing i zabezpieczenia harnessów pozostają.

## Treść bazowa (stosuj z aktualizacją zakresu)

T08 — Projekcja rosteru do natywnych peerów Claude

Cel: każdy zewnętrzny endpoint jest oddzielnie widoczny dla Claude.

Wykonaj: helpery z rzeczywistymi PID, mapę projekcji, atomic registry writes, generowanie nazw, cleanup i rekoncyliację. Testuj wieloagentowość, reuse PID, restart host agenta i zniknięcie odbiorcy. Zmierz pamięć i liczbę procesów.

Dostarcz: projection manager i testy lifecycle.

Akceptacja: jednocześnie widoczne są co najmniej trzy zewnętrzne peery; nie nadpisano żadnego prawdziwego wpisu; brak dubli po restartach; sockety nie pozostają jako fałszywie live.
