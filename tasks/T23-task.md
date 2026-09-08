# T23 — Wdrożenie lokalnej usługi i smoke

Stan początkowy: PENDING. Aktualny stan: docs/implementation-status.md.

Nadrzędne zmiany: docs/SCOPE_LOCAL_3.md. LOCAL_4 → LOCAL_3; Antigravity, capture i fizyczne rozproszenie poza MVP. Auth NAB/RBAC usunięte z zakresu; poprawny routing i zabezpieczenia harnessów pozostają.

## Treść bazowa (stosuj z aktualizacją zakresu)

T23 — Wdrożenie lokalnej usługi i smoke

Cel: rozwiązanie działa po zakończeniu sesji developera.

Wykonaj: zbuduj kontrolowany release, zainstaluj usługę użytkownika, ustaw config i credential references, uruchom launchery z nowej powłoki. Wykonaj smoke czterech harnessów, restart brokera oraz próbne odwrócenie instalacji na testowym manifeście.

Dostarcz: lokalny deployment manifest, działające status/doctor, prywatne backupy i runbook.

Akceptacja: usługa nie jest uruchomiona z usuwanego katalogu; restart nie gubi stanu; nie zmieniono autostartu innych aplikacji; użytkownik ma proste polecenia użycia i zatrzymania.
