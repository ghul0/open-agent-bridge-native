# T18 — Busy, multi-turn i równoległe rozmowy

Stan początkowy: PENDING. Aktualny stan: docs/implementation-status.md.

Nadrzędne zmiany: docs/SCOPE_LOCAL_3.md. LOCAL_4 → LOCAL_3; Antigravity, capture i fizyczne rozproszenie poza MVP. Auth NAB/RBAC usunięte z zakresu; poprawny routing i zabezpieczenia harnessów pozostają.

## Treść bazowa (stosuj z aktualizacją zakresu)

T18 — Busy, multi-turn i równoległe rozmowy

Cel: więcej niż pojedynczy ping do bezczynnego agenta.

Wykonaj: kontrolowane zadanie trwające w runtime, wiadomość w jego trakcie, wieloturową rozmowę oraz dwie równoległe rozmowy z jednym odbiorcą. Testuj przejście active→idle podczas wysyłki.

Dostarcz: trace start/steer lub jawnej kolejki, testy korelacji i braku duplikatów.

Akceptacja: Codex i Pi wykorzystują steering; Antigravity raportuje rzeczywistą semantykę; rozmowy zachowują tożsamość i kontekst; odpowiedzi nie trafiają do przypadkowego nadawcy; terminalny ACK nie uruchamia pętli.
