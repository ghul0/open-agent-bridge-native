# Końcowy odbiór LOCAL_3

Data: 2026-09-08. **Macierz live odebrana: 9/9 PASS**, po zachowanych wcześniejszych nieudanych próbach i jednym retest po jawnej zgodzie użytkownika. Końcowe wdrożenie poprawek dokumentuje release-report.md.

## Wyniki

| Bramka | Wynik i dowód |
|---|---|
| Automatyczny runner | 8/9 PASS w pierwszej sekwencji po naprawie drivera; Codex→Claude zablokowane przez classifier. Retest 1/1 PASS po jawnej zgodzie na native messaging, na tych samych session IDs. Łącznie wszystkie 9 kierunków mają kompletne evidence. |
| Oracle | Exact uczestnicy, uporządkowane tool call/result, skuteczny read nieznanego challenge, peer input i odpowiedź we właściwej sesji. Niezależny reviewer odtworzył 9/9 i nie znalazł blokującego defektu. |
| Native Claude | Prawdziwe ListAgents/SendMessage; native kontrola Claude↔Claude bez ledgeru NAB. Bez MCP/terminal injection w torze wysyłki. |
| Codex | Odrębne App Server/TUI, exact threadId i marker attach; busy `turn/steer` z expectedTurnId równym turnId, realny read/reply. |
| Pi | Czyste 0.85.1, extension peer input, dwa narzędzia, idle/busy oraz odrębne sesje we wspólnym cwd. |
| Bezpieczeństwo zgód | Żadnej automatycznej zgody na shell. Użytkownik jawnie dopuścił sesyjne dwa narzędzia NAB w Codexie oraz native ListAgents/SendMessage w testowym Claude. Testowany odczyt syntetycznego pliku nie jest transportem wiadomości. |
| Fault injection | Rzeczywisty SQLITE_FULL przez page exhaustion, readonly permissions, brak DB z markerem; odrzucona operacja nie zwiększa liczby rekordów i nie usuwa historii. |
| Hosty i ACK | Dwa logiczne hosty, routing bez broadcastu, reconnect, przerwany i obcy ACK, FIFO/TTL/unknown. To nie test dwóch fizycznych maszyn. |
| Lifecycle | Unit TERM→KILL oraz realny isolated parent/owned child/foreign child. Dodatkowo zatrzymano rzeczywisty testowy launcher Codexa: wszystkie 9 jego procesów wyszły, sąsiedni Codex przeżył. |
| Instalacja | Rzeczywisty isolated HOME: kopiowanie release, reinstall, rollback z zachowaniem obcych zmian. WAL-safe backup z integrity_check. |
| Regresje | Pełny source suite 282/282 PASS przed ostatnim dodatkowym testem walidacji runnera; testy wyłącznie źródłowe, skompilowane duplikaty wyłączone. Dodatkowy focused suite 11/11 PASS. Build/typecheck/lint PASS. |

## Zachowane błędy i naprawy

- Pierwsze próby runnera nie osiągnęły readiness; jedna odpowiedź Codexa zawierała inny niż oczekiwany marker. Nie poluzowano exact attach gate, nie zaliczono takiego startu.
- Błędna początkowa polityka zakazywała wszelkich poleceń shell, w tym technicznego odczytu pliku przez Codexa. Zawężono ją do zakazu shellowego transportu i dopuszczonego odczytu wyłącznie syntetycznego challenge.
- Opóźnienie pomiędzy wklejeniem promptu nadawcy a Enter, dłuższe oczekiwanie na rzeczywiste evidence i rozdzielenie payloadu JSON od instrukcji nadawcy usunęły wyścigi drivera.
- Poprzedni agent przerwał pracę na transient API error. Integrator przejął istniejące sześć sesji zamiast uruchamiać kolejne modele.
- Blokada native SendMessage nie została obchodzona: poproszono człowieka o zgodę, wznowiono tę samą testową sesję z zawężonym allowedTools i wykonano retest.
- Naprawiono cleanup Codex TUI/App Server przy sygnałach launchera. Oczekiwania na testy i wcześniejsze błędy są zachowane, nie usunięte z raportów.

## Prywatne dowody

Katalog stanu `native-agent-broker/acceptance-final/20260908local3d`: `final-result.json` (historyczne 8 PASS / 1 FAIL), `approved-retest-result.json` (1 PASS), `acceptance-matrix.json` (9 finalnych PASS), pliki `*-verified.json`, pane diagnostics, exact runtime traces, `real-codex-lifecycle.json`, `final-busy-codex-thread.json`. Pozostałe raporty: acceptance-faults.md i routing-benchmark.md.

## Uczciwe granice odbioru

Nie twierdzimy, że każdy przyszły model, wersja CLI albo dowolny prompt zachowa się tak samo. Native Claude może nie zwracać normalnego receipt; wtedy pozostaje delivery_unknown, a odpowiedź jest osobnym dowodem. Nie ma pełnego capture native ani obsługi wszystkich kontrolnych operacji peer protocol. Antigravity i fizyczne rozproszenie są poza MVP. Fizyczne uszkodzenie nośnika nie było symulowane — wykonano rzeczywiste błędy SQLite/filesystem oraz odtworzenie backupu.
