# T01 — Fork, baseline i pochodzenie kodu

Stan początkowy: PENDING. Aktualny stan: docs/implementation-status.md.

Nadrzędne zmiany: docs/SCOPE_LOCAL_3.md. LOCAL_4 → LOCAL_3; Antigravity, capture i fizyczne rozproszenie poza MVP. Auth NAB/RBAC usunięte z zakresu; poprawny routing i zabezpieczenia harnessów pozostają.

## Treść bazowa (stosuj z aktualizacją zakresu)

T01 — Fork, baseline i pochodzenie kodu

Cel: rozpocząć pracę na właściwym forku użytkownika.

Wykonaj: fork przez gh, klon, weryfikacja origin/upstream, gałąź robocza, przypięcie SHA, odczyt licencji, build/test baseline. Pobierz repo Pi jako referencję. Dodaj instrukcje projektu i ignorowanie prywatnych plików.

Dostarcz: upstream-lock.json, baseline report, THIRD_PARTY_NOTICES.md, działające lokalne polecenia build/test.

Akceptacja: fork ma oczekiwany parent; publiczny staging nie zawiera danych lokalnych; wszystkie błędy baseline są opisane. Test idempotencji wykrywa istniejący fork i katalog bez ich niszczenia.
