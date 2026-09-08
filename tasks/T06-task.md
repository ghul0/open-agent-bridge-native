# T06 — Host agent i supervisor

Stan początkowy: PENDING. Aktualny stan: docs/implementation-status.md.

Nadrzędne zmiany: docs/SCOPE_LOCAL_3.md. LOCAL_4 → LOCAL_3; Antigravity, capture i fizyczne rozproszenie poza MVP. Auth NAB/RBAC usunięte z zakresu; poprawny routing i zabezpieczenia harnessów pozostają.

## Treść bazowa (stosuj z aktualizacją zakresu)

T06 — Host agent i supervisor

Cel: połączyć jeden broker z lokalnymi runtime bez chaosu procesów.

Wykonaj: lifecycle adapterów, credential hosta/sesji, bindingi, leases, monitoring procesów, reconnect, lokalny spool i manifest posiadanych zasobów. Zdefiniuj interfejs adaptera: start, stop, discover/register, deliver i health/capabilities.

Dostarcz: host agent, konfigurację, testy restartów i izolacji.

Akceptacja: usługa nie zabija obcych procesów; nie publikuje swoich projekcji jako nowe sesje; odróżnia brak runtime od idle; po restarcie odtwarza tylko zasoby, do których ma prawo.
