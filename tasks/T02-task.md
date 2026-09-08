# T02 — Cztery próby kompatybilności przed pełną implementacją

Stan początkowy: PENDING. Aktualny stan: docs/implementation-status.md.

Nadrzędne zmiany: docs/SCOPE_LOCAL_3.md. LOCAL_4 → LOCAL_3; Antigravity, capture i fizyczne rozproszenie poza MVP. Auth NAB/RBAC usunięte z zakresu; poprawny routing i zabezpieczenia harnessów pozostają.

## Treść bazowa (stosuj z aktualizacją zakresu)

T02 — Cztery próby kompatybilności przed pełną implementacją

Cel: nie budować na nieistniejącym interfejsie.

Wykonaj: w osobnych sesjach sprawdź native Claude↔projekcja, Codex TUI↔właściwy App Server, API rozszerzenia Pi oraz prawdziwy tor push Antigravity. Wygeneruj schematy Codexa. Dla każdego zapisz wersję, minimalne działające wywołanie, binding sesji i ślad odbioru.

Dostarcz: compatibility-matrix.md, fixture protokołów i wyniki małych testów.

Akceptacja: co najmniej jedna prawdziwa wiadomość została przyjęta przez każdy wymagany runtime albo istnieje konkretna, udowodniona blokada. Niezgodność natywnego Claude jest blokadą centralnego wymagania; nie zastępuj go MCP. Pozostałe niezależne prace mogą postępować.
