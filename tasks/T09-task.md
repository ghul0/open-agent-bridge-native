# T09 — Native routing Claude i odpowiedzi

Stan początkowy: PENDING. Aktualny stan: docs/implementation-status.md.

Nadrzędne zmiany: docs/SCOPE_LOCAL_3.md. LOCAL_4 → LOCAL_3; Antigravity, capture i fizyczne rozproszenie poza MVP. Auth NAB/RBAC usunięte z zakresu; poprawny routing i zabezpieczenia harnessów pozostają.

## Treść bazowa (stosuj z aktualizacją zakresu)

T09 — Native routing Claude i odpowiedzi

Cel: pełny podstawowy roundtrip przez broker z niezmienionymi narzędziami Claude.

Wykonaj: mapowanie ramki native na wiadomość, walidacja nadawcy, routing do adaptera, mapowanie receipt i dostarczenie do Claude z poprawnym adresem zwrotnym. Rozwiąż korelację bez zgadywania ostatniego pytania.

Dostarcz: oba kierunki i trace powiązane z ledgerem.

Akceptacja: Claude wysyła native do Codexa/Pi/Antigravity i otrzymuje odpowiedź od właściwego peera; hold/refuse są zachowane; lokalny Claude↔Claude nadal działa i nie jest fałszywie widoczny w ledgerze.
