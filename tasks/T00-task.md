# T00 — Inwentaryzacja i bezpieczny preflight

Stan początkowy: PENDING. Aktualny stan: docs/implementation-status.md.

Nadrzędne zmiany: docs/SCOPE_LOCAL_3.md. LOCAL_4 → LOCAL_3; Antigravity, capture i fizyczne rozproszenie poza MVP. Auth NAB/RBAC usunięte z zakresu; poprawny routing i zabezpieczenia harnessów pozostają.

## Treść bazowa (stosuj z aktualizacją zakresu)

T00 — Inwentaryzacja i bezpieczny preflight

Cel: poznać środowisko bez jego niekontrolowanej zmiany.

Wykonaj: wykryj system, narzędzia, ścieżki, wersje, auth, tmux, service manager, aktywne bridge'e, zajęte porty i miejsca konfiguracji. Zidentyfikuj rzeczywisty Antigravity. Sprawdź, czy Claude ma messaging oraz czy Codex ma remote TUI. Nie odczytuj treści prywatnych rozmów w celu samej inwentaryzacji.

Dostarcz: raport lokalny i zanonimizowany, lista blokad, plan przestrzeni plików, informacja o konfliktach konfiguracji.

Akceptacja: żaden identyfikator/ścieżka wymagana do startu nie jest zgadywana; nie wykonano globalnych zmian; brakujące możliwości są oznaczone jako blokady, nie zignorowane.
