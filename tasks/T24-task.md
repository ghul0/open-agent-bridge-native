# T24 — Niezależny review, publikacja i odbiór

Stan początkowy: PENDING. Aktualny stan: docs/implementation-status.md.

Nadrzędne zmiany: docs/SCOPE_LOCAL_3.md. LOCAL_4 → LOCAL_3; Antigravity, capture i fizyczne rozproszenie poza MVP. Auth NAB/RBAC usunięte z zakresu; poprawny routing i zabezpieczenia harnessów pozostają.

## Treść bazowa (stosuj z aktualizacją zakresu)

T24 — Niezależny review, publikacja i odbiór

Cel: przekazać utrzymywalny projekt, nie jednorazową demonstrację.

Wykonaj: reviewer odtwarza kluczowe E2E i sprawdza natywność Claude, binding Codexa, Antigravity, uprawnienia i brak sekretów. Uzupełnij dokumentację, macierze zgodności i PR we własnym forku użytkownika. Nie otwieraj PR do upstream bez osobnego zlecenia.

Dostarcz: release-report.md, runbook, status wszystkich ticketów, commit/tag sprawdzonej wersji, URL własnego forka i PR.

Akceptacja: merge/release dopiero po odpowiednich bramkach. Gdy obowiązkowy harness nie działa, PR jest oznaczony jako nieukończony, a raport nie deklaruje LOCAL_4. Użytkownik dostaje wynik faktyczny wraz z uruchomionymi usługami i konkretnymi blokadami.
