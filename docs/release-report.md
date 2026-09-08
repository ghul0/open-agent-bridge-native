# Raport release LOCAL_3

Status: **CANDIDATE — wdrożenie i finalny smoke w toku**. Nie oznaczono DONE_LOCAL_3.

## Zrealizowane i zweryfikowane

- Właściwy fork, pinned upstream, zachowane MIT notices; TypeScript, istniejący RegistryServer i ChannelStore SQLite.
- Native projekcje Claude, Codex managed App Server + ten sam TUI/thread, czyste Pi 0.85.1; dwa narzędzia dla Codexa/Pi.
- 9 rzeczywistych roundtripów podstawowej macierzy potwierdzono niezależnym review i zaostrzonym oracle z właściwymi aliasami. Wcześniejsze nieudane próby zachowano, szczegóły w compatibility-matrix.md.
- Busy Codex: turn/steer z expectedTurnId, ta sama sesja/turn, read challenge i jawny MCP reply. Busy Pi: peer input przez steer, odczyt challenge i jawny reply. Wieloturowa pamięć Pi potwierdzona w tym samym sessionId.
- Native hold/refuse potwierdzone na własnych profilach bez uruchomienia modelu; brak globalnych zmian uprawnień. Poprawiono obsługę końcowego receipt po held i dodano regresję.
- Broker/host restart z zachowaniem historii i reconnect realnych Pi/Codexa, kolejne odpowiedzi dotarły do Claude.
- Dwa logiczne hosty, wiele adapterów jednego hosta, FIFO/TTL/unknown, idempotencja, konflikty ID, rate limit i WAL-safe backup zweryfikowane testami bez LLM.
- Full build/lint exit 0; ostatni pełny test suite **542 PASS / 62 pliki** (runner uwzględnia źródła i skompilowane testy, nie 542 unikalne scenariusze biznesowe).
- Installer przechodzi 9 testów, rzeczywisty candidate kopiowany bez .git, konfiguracji użytkownika i wyjścia symlinków poza release; CLI help i systemd-analyze verify PASS w izolowanym HOME.

## Jawne ograniczenia

- Native normal delivery nie daje potwierdzonego receipt w testowanym torze. Ledger może pokazywać delivery_unknown mimo późniejszego realnego odbioru. Nie zgadujemy inReplyTo dla natywnej odpowiedzi Claude.
- Nowy Codex wymaga początkowego modelowego markera attach; zajmuje jedną krótką turę. Start samej usługi nie uruchamia modeli.
- MCP ma normalne zgody harnessu. W testach użytkownik jawnie dopuścił tylko list_agents/send_message dla sesji testowych. Nie stosować tej zgody do dowolnych operacji.
- Automatyczny runner E2E wymaga dostępnego auth, zaakceptowania wymaganych promptów i strukturalnych transcriptów. Nieobecny dowód daje NOT_RUN, nie PASS. Pełna macierz była wykonana przez integratora na rzeczywistych sesjach; samo polecenie runnera nie zostało jeszcze odtworzone od zera po wszystkich poprawkach.
- Ostatni dodatkowy prompt retestu Codex→Pi został przez model skrócony do samego TEST nonce; odpowiedź nie stanowi retestu challenge i pozostaje poza PASS. Pierwotna macierz ma oddzielny poprawny scenariusz z challenge.
- Antigravity, physical distributed deployment i native capture poza MVP. Brak pełnego wsparcia wszystkich kontrolnych operacji peer protocol (np. notify_when_idle projekcji).

## Publikacja

Repo: https://github.com/ghul0/open-agent-bridge-native, gałąź feat/native-agent-messaging. Prywatne dowody w katalogu stanu użytkownika; nie wysyłane na GitHub. PR ma pozostać draft do zamknięcia końcowego odbioru.
