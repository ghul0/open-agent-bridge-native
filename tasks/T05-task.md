# T05 — Ledger, outbox i statusy

Stan początkowy: PENDING. Aktualny stan: docs/implementation-status.md.

Nadrzędne zmiany: docs/SCOPE_LOCAL_3.md. LOCAL_4 → LOCAL_3; Antigravity, capture i fizyczne rozproszenie poza MVP. Auth NAB/RBAC usunięte z zakresu; poprawny routing i zabezpieczenia harnessów pozostają.

## Treść bazowa (stosuj z aktualizacją zakresu)

T05 — Ledger, outbox i statusy

Cel: broker wie, co rzeczywiście stało się z komunikatem.

Wykonaj: trwały zapis przed ACK, idempotencja z konfliktem payloadu, kolejka per odbiorca, TTL, retry/backoff, delivery_unknown, historia zdarzeń i retencja oddzielona od inboxu. Zabezpiecz transakcje i migracje.

Dostarcz: store, migracje, testy fault injection, diagnostyka storage.

Akceptacja: restart nie gubi zaakceptowanej wiadomości; brak miejsca nie kończy się fałszywym ACK; ten sam ID nie tworzy dwóch operacji; utracone potwierdzenie runtime nie powoduje niekontrolowanego resend.
