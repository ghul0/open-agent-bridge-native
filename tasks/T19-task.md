# T19 — Awaria, bezpieczeństwo i regresje

Stan początkowy: PENDING. Aktualny stan: docs/implementation-status.md.

Nadrzędne zmiany: docs/SCOPE_LOCAL_3.md. LOCAL_4 → LOCAL_3; Antigravity, capture i fizyczne rozproszenie poza MVP. Auth NAB/RBAC usunięte z zakresu; poprawny routing i zabezpieczenia harnessów pozostają.

## Treść bazowa (stosuj z aktualizacją zakresu)

T19 — Awaria, bezpieczeństwo i regresje

Cel: nie tracić wiadomości i nie rozszerzać uprawnień pod pozorem integracji.

Wykonaj: crash brokera/adaptera/helpera, zerwanie WS, utratę ACK, pełną kolejkę, TTL, błędny payload, konflikt ID, odmowę inbound, cudzy credential, przekroczenie namespace, dwóch identycznych klientów i problemy storage. Testuj brak modyfikacji cudzych plików i procesów.

Dostarcz: testy fault injection, security report, wyniki regresji upstream.

Akceptacja: brak fałszywego sukcesu, niejawnego przejęcia endpointu, broadcastu prywatnych treści, automatycznego approval i bezgranicznego retry. Nieznana dostawa jest oznaczona jako nieznana.
