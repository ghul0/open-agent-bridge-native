# T10 — Dwa narzędzia i uwierzytelnienie klienta

Stan początkowy: PENDING. Aktualny stan: docs/implementation-status.md.

Nadrzędne zmiany: docs/SCOPE_LOCAL_3.md. LOCAL_4 → LOCAL_3; Antigravity, capture i fizyczne rozproszenie poza MVP. Auth NAB/RBAC usunięte z zakresu; poprawny routing i zabezpieczenia harnessów pozostają.

## Treść bazowa (stosuj z aktualizacją zakresu)

T10 — Dwa narzędzia i uwierzytelnienie klienta

Cel: jednolite discovery/send dla harnessów innych niż Claude.

Wykonaj: serwis aplikacyjny list/send, cienki MCP, walidację schematów, binding nadawcy, namespace, błędy i asynchroniczne przyjęcie. Ukryj zbędne narzędzia upstream w profilu NAB bez usuwania ich z bazowego projektu.

Dostarcz: list_agents, send_message, testy autoryzacji i konfiguracji.

Akceptacja: oba narzędzia wystarczają do wieloturowej rozmowy; model nie może wpisać cudzej tożsamości; brak brokera jest błędem, nie pustą listą; nie są wymagane register, poll ani reply wykonywane przez model.
