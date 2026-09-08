# T07 — Moduł Claude wire protocol

Stan początkowy: PENDING. Aktualny stan: docs/implementation-status.md.

Nadrzędne zmiany: docs/SCOPE_LOCAL_3.md. LOCAL_4 → LOCAL_3; Antigravity, capture i fizyczne rozproszenie poza MVP. Auth NAB/RBAC usunięte z zakresu; poprawny routing i zabezpieczenia harnessów pozostają.

## Treść bazowa (stosuj z aktualizacją zakresu)

T07 — Moduł Claude wire protocol

Cel: mały, testowalny adapter protokołu zamiast kopii rozszerzenia Pi.

Wykonaj: wydziel portowalny kod, zachowaj notices, dodaj walidację i testy aktualnej wersji. Wprowadź parametr ścieżek i zależności systemowych, żeby unit testy nie dotykały prawdziwego HOME. Obsłuż lifecycle socketu i właściwą semantykę ramek.

Dostarcz: moduł claude-native, fixture, unit/contract tests.

Akceptacja: parser działa przy fragmentacji i wielu ramkach; błędne dane nie wywołują dowolnych operacji na plikach; half-close nie powoduje pozornych timeoutów; nie zmieniono zabezpieczeń Claude.
