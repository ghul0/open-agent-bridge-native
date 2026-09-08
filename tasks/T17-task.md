# T17 — Macierz komunikacji wszystkich czterech harnessów

Stan początkowy: PENDING. Aktualny stan: docs/implementation-status.md.

Nadrzędne zmiany: docs/SCOPE_LOCAL_3.md. LOCAL_4 → LOCAL_3; Antigravity, capture i fizyczne rozproszenie poza MVP. Auth NAB/RBAC usunięte z zakresu; poprawny routing i zabezpieczenia harnessów pozostają.

## Treść bazowa (stosuj z aktualizacją zakresu)

T17 — Macierz komunikacji wszystkich czterech harnessów

Cel: udowodnić, że każdy może inicjować kontakt z każdym.

Wykonaj: 12 kierunków między różnymi harnessami, cztery kierunki diagonalne między dwiema odrębnymi sesjami tego samego harnessu i kontrolę bezpośredniego Claude↔Claude. Szczegóły oracle opisano w rozdziale 19.

Dostarcz: macierz PASS/FAIL/BLOCKED, nonce, ID sesji, trace i wiadomości ledgeru.

Akceptacja: dla LOCAL_4 wszystkie wymagane scenariusze przechodzą realnie. Atrapa, ukryty wątek lub dostarczenie do niewłaściwej sesji to FAIL, nawet gdy tekst odpowiedzi jest poprawny.
