# T12 — Rozszerzenie Pi

Stan początkowy: PENDING. Aktualny stan: docs/implementation-status.md.

Nadrzędne zmiany: docs/SCOPE_LOCAL_3.md. LOCAL_4 → LOCAL_3; Antigravity, capture i fizyczne rozproszenie poza MVP. Auth NAB/RBAC usunięte z zakresu; poprawny routing i zabezpieczenia harnessów pozostają.

## Treść bazowa (stosuj z aktualizacją zakresu)

T12 — Rozszerzenie Pi

Cel: prawdziwe Pi uczestniczy w sieci brokera.

Wykonaj: rejestrację sesji, odbiór, dwa narzędzia, lifecycle/reload oraz integrację launchera. Użyj API rozszerzeń aktualnej wersji. Wyeliminuj równoczesny bezpośredni tor oryginalnego pi-claude-link w sesji zarządzanej.

Dostarcz: rozszerzenie, testy API i E2E z interaktywnym Pi.

Akceptacja: idle i busy działają bez modelowego pollingu; po reloadzie nie ma podwójnego odbioru; dwie równoległe rozmowy nie otrzymują wspólnego końcowego tekstu.
