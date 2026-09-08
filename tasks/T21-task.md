# T21 — Kontrakt hostów i testy rozproszonego pośrednika

Stan początkowy: PENDING. Aktualny stan: docs/implementation-status.md.

Nadrzędne zmiany: docs/SCOPE_LOCAL_3.md. LOCAL_4 → LOCAL_3; Antigravity, capture i fizyczne rozproszenie poza MVP. Auth NAB/RBAC usunięte z zakresu; poprawny routing i zabezpieczenia harnessów pozostają.

## Treść bazowa (stosuj z aktualizacją zakresu)

T21 — Kontrakt hostów i testy rozproszonego pośrednika

Cel: wyniesienie brokera nie wymaga pisania adapterów od nowa.

Wykonaj: rozdziel host identity od agent identity, dodaj auth hosta, konfigurację transportu, snapshot/replay, ochronę przed projekcjami w pętli i test dwóch logicznych hostów. Wyłącz domyślnie forwarding poza maszynę.

Dostarcz: kontrakt host transport, testy opóźnień/reconnect oraz instrukcję drugiego hosta.

Akceptacja: broker nie używa zdalnych ścieżek/PID jako lokalnych; nie wymaga udostępnienia App Serverów na Internet; niewłaściwy host nie może przejąć agentów innego hosta.
