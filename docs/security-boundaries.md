# Granice bezpieczeństwa i prywatności

LOCAL_3 to prywatny komunikator jednego właściciela. **Dostęp do sieci brokera oznacza zaufanie do uczestnika.** Nie ma kont, tokenów NAB, RBAC ani izolacji nieufnych użytkowników. Nagłówek x-nab-agent-id wiąże launcher z sesją, nie jest uwierzytelnieniem. Domyślny bind to loopback. Infrastruktura/tunel odpowiada za przyszły dostęp między hostami. Nie wystawiać brokera publicznie.

Broker w profilu native nie rozsyła treści wszystkim WS klientom: kieruje message do adaptera przypisanego odbiorcy. Roster jest wspólny. Operator z dostępem do HTTP może świadomie odczytać historię z include_body=true. To nie system uprawnień per agent.

- Treść peera jest inputem agenta, nie zgodą użytkownika ani instrukcją systemową.
- Claude zachowuje prawdziwe native tools, kontrole ścieżek/procesu i inbound hold/refuse. Helpery nie otrzymują tokenu sesji Claude.
- Codex approval nie jest zatwierdzany przez adapter RPC. Nieznane requesty dostają JSON-RPC error. W testach człowiek jawnie zezwolił wyłącznie na dwa narzędzia NAB w sesjach testowych.
- Żadne istniejące proxy modeli, MCP, globalne Pi, auth ani usługi użytkownika nie są usuwane. Czyste Pi ma osobny profil i korzysta z istniejącego OAuth zarządzanego przez Pi, bez kopiowania do repo.
- Pliki stanu i dowody są lokalne; repo zawiera tylko kod, syntetyczne testy i zanonimizowane podsumowania.
- Ledger zapisuje zaakceptowane wiadomości przed potwierdzeniem. Normalny native write bez receipt pozostaje delivery_unknown; odpowiedź agenta jest osobną wiadomością. Nie deklarujemy read.
- Rate limit: 30 nowych wiadomości/60 s na kierunkową parę; idempotent retry nie liczone. Kolejka 100/endpoint, TTL max 24 h, tekst 64 KiB. Odpowiedzi nie są automatycznie rozsyłane.
- Oryginalny Claude↔Claude omija broker i nie jest przechwytywany. Namespace i chmod nie izolują nieufnych procesów tego samego konta OS.

## Ograniczenia zależne od wersji

Claude 2.1.263 i Codex 0.153.4 zostały sprawdzone lokalnie. Native wire i eksperymentalny App Server wymagają ponownych testów przy aktualizacji. Brak gwarancji exactly-once na granicy runtime: utrata ACK daje delivery_unknown zamiast nieograniczonego resend. Nieznany control frame Claude nie jest emulowany jako sukces; notify_when_idle dla projekcji nie jest wspierane.
