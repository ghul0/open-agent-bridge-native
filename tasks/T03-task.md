# T03 — Kontrakty, zakres i decyzje

Stan początkowy: PENDING. Aktualny stan: docs/implementation-status.md.

Nadrzędne zmiany: docs/SCOPE_LOCAL_3.md. LOCAL_4 → LOCAL_3; Antigravity, capture i fizyczne rozproszenie poza MVP. Auth NAB/RBAC usunięte z zakresu; poprawny routing i zabezpieczenia harnessów pozostają.

## Treść bazowa (stosuj z aktualizacją zakresu)

T03 — Kontrakty, zakres i decyzje

Cel: wspólny model dla wszystkich wykonawców.

Wykonaj: doprecyzuj schemat endpointu, wiadomości, błędów, receipt, lease, adapterów i dwóch narzędzi. Zapisz wybrany wariant App Serverów oraz projekcji PID. Zapisz politykę odpowiedzi i zakres capture. Stwórz testy schematów i przykłady.

Dostarcz: architecture.md, ADR, typy i walidatory, mapowanie FR→ticket→test.

Akceptacja: żaden adapter nie wymaga własnej definicji agentId ani osobnego registry. Dokumentacja odróżnia cechy potwierdzone od eksperymentalnych.
