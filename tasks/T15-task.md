# T15 — Doctor, historia i diagnostyka operatorska

Stan początkowy: PENDING. Aktualny stan: docs/implementation-status.md.

Nadrzędne zmiany: docs/SCOPE_LOCAL_3.md. LOCAL_4 → LOCAL_3; Antigravity, capture i fizyczne rozproszenie poza MVP. Auth NAB/RBAC usunięte z zakresu; poprawny routing i zabezpieczenia harnessów pozostają.

## Treść bazowa (stosuj z aktualizacją zakresu)

T15 — Doctor, historia i diagnostyka operatorska

Cel: operator odróżnia błąd transportu, harnessu, logowania i modelu.

Wykonaj: polecenia agentów, wiadomości i statusu; widoczność trasy i receipts; zakres capture; health/capabilities per adapter. Wykorzystaj istniejący dashboard tam, gdzie ma to sens, bez budowania nowego produktu UI.

Dostarcz: doctor JSON, czytelny CLI, bezpieczny podgląd historii.

Akceptacja: status nie pokazuje „online” dla nieosiągalnej sesji; treści nie wyciekają do nieuprawnionych subskrybentów; publiczny raport nie zawiera sekretów ani prywatnych ścieżek.
