# T16 — Test runner prawdziwych sesji w tmux

Stan początkowy: PENDING. Aktualny stan: docs/implementation-status.md.

Nadrzędne zmiany: docs/SCOPE_LOCAL_3.md. LOCAL_4 → LOCAL_3; Antigravity, capture i fizyczne rozproszenie poza MVP. Auth NAB/RBAC usunięte z zakresu; poprawny routing i zabezpieczenia harnessów pozostają.

## Treść bazowa (stosuj z aktualizacją zakresu)

T16 — Test runner prawdziwych sesji w tmux

Cel: mieć powtarzalne E2E bez ręcznego klikania.

Wykonaj: osobny serwer tmux, launchery fixture, unikalny run ID, checkpointy gotowości, trace narzędzi i runtime, oracle nonce oraz cleanup. Rozdziel prompt inicjujący test od transportu wiadomości.

Dostarcz: oab-native e2e --tmux, test manifest i raporty maszynowe.

Akceptacja: runner nie używa globalnego kill-server; nie udaje wyniku echo; timeout daje FAIL/BLOCKED z dowodami; uruchomienie i zatrzymanie dotyczy tylko zasobów testu.
