# T22 — Rzeczywisty test dwóch maszyn, tylko gdy dostępne

Stan początkowy: OUT_OF_MVP. Aktualny stan: docs/implementation-status.md.

Nadrzędne zmiany: docs/SCOPE_LOCAL_3.md. LOCAL_4 → LOCAL_3; Antigravity, capture i fizyczne rozproszenie poza MVP. Auth NAB/RBAC usunięte z zakresu; poprawny routing i zabezpieczenia harnessów pozostają.

## Treść bazowa (stosuj z aktualizacją zakresu)

T22 — Rzeczywisty test dwóch maszyn, tylko gdy dostępne

Cel: osobno potwierdzić działanie sieciowe.

Wykonaj: na jawnie autoryzowanym drugim hoście wdroż host agent, uruchom testowy harness, przetestuj roundtrip i reconnect przez zabezpieczony transport. Nie kupuj infrastruktury i nie zgaduj credentiali.

Dostarcz: raport rzeczywistej topologii i dowodów albo NOT_RUN_NO_AUTHORIZED_SECOND_HOST.

Akceptacja: tylko rzeczywisty roundtrip daje DISTRIBUTED_VERIFIED. Brak hosta nie blokuje lokalnego wdrożenia czterech harnessów, ale pozostaje widoczny w raporcie.
