# Architektura centralnego Codexa

Nadrzędne wymagania: SCOPE_SHARED_CODEX.md, następnie SCOPE_LOCAL_3.md. Jeden RegistryServer upstream i jedna SQLite ChannelStore. Bez platformy auth i bez wrappera Codexa.

## Procesy i odpowiedzialność

- `codex-app-server.service`: jeden natywny runtime środowiska, zarządzany niezależnie od NAB. Wiele TUI i proxy SSH jest klientami tego samego runtime.
- `nab-broker.service`: rejestr, routing, ledger/outbox/statusy, bez dostępu do filesystemu zdalnych hostów.
- `nab-host.service`: lokalny klient brokera; adaptery Claude-native i `codex-central`. To nie drugi broker. Nie uruchamia ani nie zabija Codexa/TUI.
- Pi używa własnego czystego extension/lifecycle i tego samego kontraktu brokera.

Zwykły Codex w zweryfikowanym środowisku korzysta z działającej centrali bez --remote. Jawne `--remote unix://…` pozostaje opcją natywnego CLI do diagnostyki; nie jest wymaganiem NAB. `coy` pozostaje nietkniętym skrótem do Codexa.

## Codex

CodexConnection: WebSocket-over-UDS, wymagany Host localhost, request correlation/timeout i obserwacja server requests bez autoapproval. CodexHost: jedno połączenie, paginowane thread/loaded/list, subscribe nowego wątku, eventy, serializowany reconcile, start/steer i disconnected/awaiting_approval.

Loaded thread oznacza dostępną sesję runtime, nie gwarancję konkretnego widoku TUI. Historycznych wątków nie wznawiamy w discovery. Tworzenie sesji pozostaje natywnemu Codexowi; próba API-created→TUI była osobnym testem. Pusty wątek bez trwałej tury może nie mieć rollout do resume.

MCP: tylko list_agents/send_message. Nadawca z `extra._meta.threadId`, zweryfikowany względem zarejestrowanego endpointu; brak metadanych daje błąd. Nie ma per-session binding.json ani argumentu from. Pliki binding test runnera służą tylko jako dowód exact thread, nie jako źródło nadawcy.

Nazwa: thread.name / /rename / thread/name/set. NAB synchronizuje alias, ale agentId = nativeAgentId(hostId,harness,threadId) nie zmienia się. Nie ma codex --name. Kolizja nazwy jest jawna. Model dostaje deduplikowane powiadomienie o nazwie; current name jest także metadanymi odbiorcy przy wiadomości i self w list_agents.

## Broker i hosty

Pozostają istniejące HTTP `/native/agents`, `/native/messages`, `/native/health` i WS rejestracja/delivery/receipt. `/native/identity` jest wewnętrzną operacją adaptera, nie dodatkowym narzędziem modelowym; name revision i queued message są zapisywane atomowo w tej samej SQLite. Reconnect nie tworzy kolejnego powiadomienia tej samej nazwy.

Migracja legacy owner `codex:<name>` → `codex-central` jest jawna, transakcyjna i idempotentna; rollback CAS nie nadpisuje późniejszych zmian. Historia i agentId pozostają.

Zaufana sieć, loopback domyślnie, brak kont/tokenów NAB/RBAC. Prywatna treść jest kierowana wyłącznie do właściwego adaptera. Peer message nie jest zgodą użytkownika. Native Claude zachowuje ListAgents/SendMessage i hold/refuse, bez capture oryginalnego Claude↔Claude.

## Granice

Unixowy daemon ma mechanizm singleton dla własnego socketu. Nie blokuje innych natywnych trybów ws/stdio/embedded. Doctor rozróżnia runtime, proxy i Node launcher; raportuje duplikaty, nie zabija ich automatycznie. Globalny zakaz tworzenia runtime bez patchowania/wrappera/izolacji OS nie jest deklarowany.
