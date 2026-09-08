# Architektura LOCAL_3

Nadrzędny zakres: SCOPE_LOCAL_3.md. Jeden RegistryServer upstream i jeden ChannelStore SQLite. Rozszerzamy je o profil native; nie uruchamiamy drugiego niezależnego brokera.

## Granice

- Broker: endpointy, routing per host, zapis przed ACK, outbox i statusy. Bez lokalnych socketów/procesów harnessów.
- Host adapter: wychodzący WS, rejestracja własnych endpointów, runtime delivery i reconnect. Adres brokera i hostId konfigurowalne.
- Projekcja Claude: jeden realny PID per zewnętrzny endpoint, zgodny registry/socket; adres zwrotny odpowiada nadawcy. Oryginalne sesje Claude nie są modyfikowane.
- Codex: osobny App Server i remote TUI per sesja; wiązanie konkretnego threadId. Pi: czysta izolowana instalacja + extension.
- Narzędzia list_agents/send_message są cienkimi klientami wspólnego serwisu. Tożsamość bierze się z bindingu endpointu w launcherze, nie z argumentu modelu.
- Zaufana sieć: brak tokenów NAB/RBAC. Dostęp do brokera oznacza zaufanie. Nie zapewniamy izolacji nieufnych procesów. Loopback domyślnie; żadnej publicznej ekspozycji.

## Wspólny kontrakt implementacyjny

Typescript `src/native/contracts.ts`, Zod. HTTP `/native/agents`, POST `/native/messages` (header `x-nab-agent-id` z bindingu klienta), GET `/native/messages` (bez treści domyślnie), GET `/native/health`.

WS istniejącego RegistryServer `/ws`: `{type:"native.register", hostId, instanceId, endpoints:[...]}`; `{type:"native.heartbeat",hostId}`; broker odpowiada `{type:"native.roster",agents:[...]}` i kieruje `{type:"native.deliver",message:...}` tylko do właściwego hosta. Adapter odpowiada `{type:"native.receipt",messageId,state,detail?}`. Zmiana snapshotu nie przenosi kolejki między sesjami. Reconnect powtarza snapshot. Roster nie ujawnia private bindingów.

Endpoint: agentId (deterministyczne host+harness+nativeSessionId), hostId, instanceId, harness, displayName, nativeSessionId, state, reachable, capabilities {receiveIdle,receiveBusy}. Private cwd/socket/port tylko u host adaptera.

Send: to,text,conversation_id?,in_reply_to?,delivery:auto|steer|queue,expects_reply=false,expires_in_seconds=600,idempotency_key?. SDK generuje idempotency key raz na operację; retry zachowuje ID. Weryfikacja duplikatu porównuje payload. Dwa niezależne tool calls to dwie operacje.

Message: messageId,conversationId,fromAgentId,toAgentId,sourceInstanceId,text,createdAt,expiresAt,deliveryPolicy,expectsReply,inReplyTo?,schemaVersion:1. Statusy: accepted,queued,runtime_accepted,held,responded,failed,expired,delivery_unknown. Próba zapisana przed wysyłką, brak ACK po zerwaniu = delivery_unknown, bez ślepego resend. Per recipient FIFO, 100 queued, tekst 64 KiB, TTL max 24h.

## Dowody i ograniczenia

Native probe 2026-09-08 na Claude 2.1.263: helper z realnym PID był widoczny w ListAgents, odebrał native SendMessage i odpowiedź helpera dotarła do bieżącego kontekstu Claude. To test wire, nie pełny model-model E2E. Nie dowodzi hold/refuse ani całego protokołu kontrolnego. Helper był dzieckiem sesji; oddzielny test polityk musi uniknąć uznania własnego dziecka za zwykłego peera.
Codex/Pi live probes w toku. Capture Claude↔Claude i Antigravity poza MVP. Dwa logiczne hosty lokalnie to test kontraktu, nie dwóch maszyn.
