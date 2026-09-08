NAB — aktualizacja zakresu i polecenie realizacji po audycie

Masz już SPEC_NATIVE_AGENT_BROKER.md oraz wykonaną analizę środowiska i upstreamu. Poniższe ustalenia mają pierwszeństwo przed sprzecznymi zapisami wcześniejszej specyfikacji. Zaktualizuj odpowiednie wymagania, backlog i kryteria odbioru, a następnie przejdź do implementacji.

1. Cel: prywatne, ultra KISS rozwiązanie

Budujemy działający komunikator między moimi agentami, nie platformę wieloużytkownikową ani uniwersalny system orkiestracji.

Wykorzystaj istniejący broker open-agent-bridge i potrzebne fragmenty mechanizmu pi-claude-link. Nie pisz całego serwera od nowa. Jednocześnie nie zakładaj, że upstream wymaga wyłącznie podmiany adaptera Claude — napraw również wykazane problemy na ścieżkach potrzebnych do naszego MVP.

Preferuj jeden projekt, istniejące mechanizmy, jedną bazę SQLite, cienkie adaptery i prostą konfigurację. Bez frameworka pluginów, mikroserwisów, własnego systemu uprawnień i rozbudowanego dashboardu.

KISS oznacza mniej zakresu i mniej elementów, nie ciche gubienie wiadomości ani pozorne zaliczanie testów.

2. Obowiązujący zakres MVP
Obszar    Decyzja
Claude Code    W MVP. Natywne ListAgents i SendMessage; bez wymuszania narzędzia MCP lub komendy NAB do wysyłania.
Codex    W MVP. Narzędzia list_agents i send_message; odbiór przez kontrolowane połączenie z App Serverem.
Pi    W MVP. Czyste Pi, bez dostosowywania NAB do moich customowych rozszerzeń.
Antigravity    Poza MVP. Nie implementuj ani nie testuj tej integracji w ramach odbioru MVP.
Wiele hostów    Wdrożenie rozproszone i test na drugim rzeczywistym hoście poza MVP, ale podstawy rozwiązania mają być na to gotowe.
Capture lokalnego Claude↔Claude    Nie jest warunkiem odbioru MVP. Osobny eksperyment; w MVP nie ingeruj w istniejący natywny tor.

Zmień obowiązujący profil odbioru z LOCAL_4 na LOCAL_3. Antigravity i rzeczywiste rozproszenie oznacz jako poza zakresem MVP, a nie jako błędy blokujące zakończenie projektu.

Nie usuwaj z dokumentacji kierunku docelowego — oddziel go od wymagań pierwszego wdrożenia.

3. Wiele hostów: nie wdrażamy teraz, ale przygotowujemy podstawy

Brak drugiego hosta nie jest problemem wykonawczym MVP. Nie chcę jednak wersji lokalnej, którą później trzeba będzie przebudować, aby dodać kolejną maszynę.

Już teraz zapewnij:

Rozdzielenie brokera i lokalnego adaptera. Broker odpowiada za rejestr, routing i zapis wiadomości. Dostęp do socketów Claude, procesów i runtime’ów należy do adaptera na danym hoście.
Konfigurowalny adres brokera i identyfikator hosta. Adapter ma inicjować połączenie do brokera. Adres nie może być zaszyty jako lokalny, a globalna tożsamość agenta nie może opierać się wyłącznie na PID, nazwie lub cwd.
Routing przez przypisany adapter. Broker nie może zakładać, że ma dostęp do lokalnego filesystemu każdego agenta. Zadbaj o ponowne połączenie, aktualizację rejestracji i rozpoznawanie niedostępnego adaptera.

Wykorzystaj istniejący transport projektu, o ile wystarcza. Nie projektuj klastra, federacji brokerów, automatycznego wykrywania maszyn ani wysokiej dostępności. Docelowy model to jeden broker i adaptery na kolejnych hostach.

W MVP sprawdź tę granicę lokalnie: uruchom dwa logiczne adaptery z różnymi identyfikatorami hosta i przetestuj routing oraz reconnect. Nie nazywaj tego testem dwóch rzeczywistych maszyn.

Dodanie drugiego hosta powinno później polegać na instalacji adaptera, ustawieniu adresu brokera i zapewnieniu dostępu sieciowego — bez zmiany podstaw protokołu i modelu danych.

4. Bezpieczeństwo: networking, nie własna platforma security

To prywatny system jednego właściciela, działający na zaufanych maszynach.

Nie implementuj własnych kont, logowania, tokenów NAB, RBAC, ACL per agent, wielodostępności ani zarządzania certyfikatami. Bezpieczeństwo między hostami zapewnię na poziomie sieci lub tunelu.

Lokalnie serwer powinien domyślnie nasłuchiwać na loopback. Przy rozproszeniu adres nasłuchu będzie konfigurowalny, a dostęp ograniczony przez infrastrukturę. Nie wystawiaj brokera publicznie.

Jawnie udokumentuj założenie: dostęp do sieci brokera oznacza zaufanie do uczestnika. Broker nie zapewnia izolacji między nieufnymi użytkownikami.

Nadal obowiązuje poprawność i higiena: walidacja wiadomości, właściwy routing, niewypisywanie sekretów, zachowanie konfiguracji użytkownika oraz wymagane zabezpieczenia natywnych protokołów harnessów. Nie usuwaj ich mechanizmów autoryzacji ani nie obchodź ograniczeń runtime’u.

Broadcast treści wiadomości do wszystkich klientów zastąp dostarczeniem do właściwego adaptera — jako poprawkę routingu, bez budowania systemu uprawnień.

5. Pi i limity modeli
Czyste Pi

Pracujemy na czystej wersji Pi, bez customowego role layer, teamów i wcześniejszych integracji messagingowych.

Przygotuj izolowaną instalację lub profil NAB, z rozszerzeniem potrzebnym do komunikacji. Możesz wykorzystać istniejące uwierzytelnienie i konfigurację dostawcy, ale bez kopiowania sekretów do repozytorium.

Nie usuwaj globalnie obecnego customowego Pi ani rozszerzeń. Nowe środowisko ma być jednoznaczne i uruchamiane osobnym launcherem. Ewentualną trwałą migrację wykonamy osobno.

Gemini i GLM

Stan BLOKADA oznacza odnawialny limit użycia, nie trwały zakaz tych modeli i nie blokadę projektu.

Nie zmieniaj z tego powodu architektury ani nie zatrzymuj niezależnych prac. Przed generacją sprawdzaj aktualną dostępność. Niewykonany z powodu limitu test oznacz zgodnie z prawdą. Nie obchodź limitów ani nie przełączaj po cichu modelu.

6. Najpierw udowodnij krytyczne integracje

Przed większą rozbudową wykonaj minimalne próby na rzeczywistych runtime’ach:

Claude: zarejestruj kontrolowanego peera wzorowanego na pi-claude-link, potwierdź widoczność w natywnym ListAgents, odbierz prawdziwe SendMessage i dostarcz odpowiedź do właściwej sesji. Zachowaj istniejące proxy modeli — nie jest częścią transportu NAB.

Codex: uruchom kontrolowany App Server i podłączony do niego widoczny TUI. Udowodnij zgodność threadId oraz odbiór wiadomości w tym samym wątku podczas bezczynności i pracy. Nie przejmuj automatycznie istniejącej usługi ani przypadkowych sesji użytkownika. Docelowo używaj turn/start dla bezczynnego odbiorcy i turn/steer dla aktywnego, z obsługą zmiany stanu pomiędzy sprawdzeniem a wysyłką.

Pi: uruchom czysty profil, dodaj list_agents i send_message, a odbiór realizuj przez API/lifecycle rozszerzenia. Agent nie ma ręcznie odpytywać skrzynki ani uruchamiać polecenia odbioru.

Nie traktuj obecności flag w --help, zapisu w bazie lub transportowego ACK jako dowodu, że wiadomość dotarła do kontekstu agenta.

7. Minimalny kontrakt działania

Zachowaj następujące wymagania:

Tożsamość: wiele sesji tego samego harnessu w jednym katalogu musi działać niezależnie. Nie utożsamiaj projektu z agentem. Projekcji peerów NAB nie rejestruj ponownie jako nowych lokalnych agentów.

Dostarczanie: nie gub po cichu zaakceptowanych wiadomości. Przepełnienie kolejki, niedostępny odbiorca i problem z bazą muszą dawać jawny wynik. Utrata historii nie może kończyć się odtworzeniem pustej bazy i udawaniem sukcesu.

Retry: techniczne ponowienie tej samej wysyłki zachowuje identyfikator i podlega deduplikacji. Nie utożsamiaj dwóch niezależnych wywołań modelu z jednym retry.

Statusy: rozróżniaj przyjęcie przez broker, potwierdzenie przyjęcia przez runtime — gdy interfejs je zapewnia — oraz odpowiedź agenta. Nie obiecuj „przeczytania” bez dowodu. Odpowiedź agenta jest kolejną wiadomością, nie osobnym systemem zarządzania zadaniami.

Historia: zapisuj ruch przechodzący przez NAB. Nie deklaruj capture bezpośredniego lokalnego Claude↔Claude.

8. Implementacja, testy i wdrożenie

Kontynuuj od obecnego audytu. Nie wykonuj go ponownie od zera bez potrzeby.

Utwórz właściwy fork przez gh, przygotuj repozytorium lokalne i zachowaj wymagane informacje licencyjne. Nie wykorzystuj przypadkowo istniejących forków innych projektów. Przypnij zależności dla tego projektu bez globalnej przebudowy środowiska.

Testy wykonuj w osobnym namespace tmux, bez ingerowania w moje działające sesje.

Odbiór LOCAL_3 wymaga rzeczywistych testów:

wszystkich sześciu kierunków między różnymi harnessami: Claude↔Codex, Claude↔Pi, Codex↔Pi;
Codex↔Codex i Pi↔Pi między osobnymi sesjami oraz sprawdzenia braku regresji natywnego Claude↔Claude;
dostarczania podczas pracy i bezczynności, rozmowy wieloturowej, dwóch sesji w jednym cwd, restartu/reconnect i niedostępnego odbiorcy.

Dla testów odbioru zachowuj identyfikatory wiadomości i sesji oraz dowody odpowiedzi z właściwego runtime’u. Mocki mogą wspierać testy automatyczne, ale nie zastępują E2E.

Po zaliczeniu testów wdroż lokalną usługę oraz proste launchery Claude, Codexa i czystego Pi. Dostarcz instrukcję uruchomienia, zatrzymania, diagnostyki i rollbacku. Osobno opisz późniejsze podłączenie kolejnego hosta.

Nie kończ na zaktualizowanej specyfikacji lub kolejnym planie. Zrealizuj implementację, testy i lokalne wdrożenie. Jeżeli pojawi się rzeczywista blokada, udokumentuj dokładnie próbę, wynik i wpływ na zakres, a niezależne prace kontynuuj. Nie dodawaj zastępczego mechanizmu, który łamie wymaganie natywnego Claude, tylko po to, żeby zaliczyć MVP.
