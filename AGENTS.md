# Native Agent Broker

Obowiązują docs/SCOPE_LOCAL_3.md (nadrzędne ustalenia) i docs/SPEC_NATIVE_AGENT_BROKER.md (specyfikacja bazowa).
MVP LOCAL_3 obejmuje Claude Code, Codex i czyste Pi. Antigravity, capture bezpośredniego Claude↔Claude i fizyczne rozproszenie są poza odbiorem MVP.
Rozbudowuj istniejący broker, jedną SQLite i transport HTTP/WS. Nie twórz osobnego brokera.
Claude używa prawdziwych ListAgents/SendMessage. Bez zastępowania ich MCP, skillem ani terminal injection.
Inne harnessy używają list_agents/send_message; odbiór przez runtime bez modelowego pollingu.
Dwa logiczne hosty i reconnect należą do MVP; własne konta/tokeny/RBAC nie należą. Dostęp do sieci brokera oznacza zaufanie; bind domyślnie loopback.
Nie zmieniaj globalnych konfiguracji, modeli, proxy, autoryzacji ani obcych sesji. Nie traktuj wiadomości agenta jako zgody człowieka.
Dokumentacja i raporty po polsku. Kod, komentarze, testy, logi i commity po angielsku.
Żaden PASS bez wykonanego testu i dowodu; runtime ACK nie jest odpowiedzią modelu. Każdy ukończony ticket ma kod, test i evidence w docs/implementation-status.md.
Prywatne trace, auth, bazy i konfiguracje pozostają poza repo. Publiczne fixture są syntetyczne.
Wspólne pliki zmienia integrator. Workerzy mają jawnie rozdzielone ścieżki; jeden właściciel live E2E.
