# Zgodność LOCAL_3

Data testu: 2026-09-08. Linux x86_64; Node 22.20.0. **Macierz podstawowa ma 9 potwierdzonych roundtripów** na rzeczywistych sesjach, niezależny review potwierdził ich autentyczność, a zaostrzony oracle odtworzył 9/9 PASS. Dodatkowo smoke zainstalowanego release i restart/reconnect przeszły. Pełny automatyczny odbiór pozostaje częściowy — patrz implementation-status.md.

| Inicjacja | Wynik końcowej próby | Mechanizm / dowód |
|---|---|---|
| Claude → Codex | PASS | native SendMessage → projekcja → broker → turn/start → MCP reply → native input Claude |
| Codex → Claude | PASS | MCP list/send → native input → native SendMessage → wejście tego samego Codexa |
| Claude → Pi | PASS | native tools → extension peer input → jawny send_message → native input |
| Pi → Claude | PASS | extension tools → native input → native reply → Pi custom_message |
| Codex → Pi | PASS po retest | MCP → Pi read challenge i explicit reply → ten sam thread Codexa |
| Pi → Codex | PASS | extension → Codex read challenge i MCP reply → Pi custom_message |
| Codex → drugi Codex | PASS po retest | odrębne threadId, ten sam cwd, odpowiedź we właściwym wątku |
| Pi → drugie Pi | PASS | odrębne sessionId, ten sam cwd, brak miksowania odbiorcy |
| Claude → drugi Claude | PASS | oryginalny native transport, brak capture w brokerze |

Oracle: exact session/thread ID, rzeczywiste narzędzie nadawcy, wejście odbiorcy, odczyt syntetycznego challenge, jawna odpowiedź i jej wejście u nadawcy. Pliki challenge generowane losowo, wartości nieobecne w promptach nadawców. Pane to wyłącznie dodatkowa diagnostyka. Prywatny `e2e/structured-oracle.json` zawiera kontrole; fixture unit nie liczone jako live.

## Zachowane wcześniejsze niepowodzenia

- Dwa pierwsze starty managed Codex upadły na `list_turns is not supported yet` przed TUI. Poprawiono kolejność inicjalizacji, następny start z potwierdzonym markerem modelowym przeszedł.
- Pierwszy Codex→Pi odpowiedział poprawnym challenge bez pełnego nonce; wymagany retest z jednoznacznym promptem przeszedł.
- Pierwsza diagonala Codexa: model odmówił bez ustalonej polityki testowego odbiorcy. Druga próba miała błędne in_reply_to i została poprawnie odrzucona przez broker. Trzecia inicjacja po poprawce promptu przeszła. Nie usuwano trace odmowy.
- Wczesny busy probe Pi miał znikającego nadawcę fixture i 409 przy odpowiedzi. W pełnym teście z rzeczywistym nadawcą Claude otrzymano odpowiedź po steer.
- Wczesny Codex probe wykonawcy zawierał kliknięcie approval przez agenta. Nie zalicza kontroli zgody człowieka. W poprawionych E2E uzyskano jawną zgodę użytkownika wyłącznie na list_agents/send_message w testowych sesjach, bez zgód na shell i bez trwałej konfiguracji.

## Runtime

- Claude Code 2.1.263: native discovery, message, zwrotny adres każdej projekcji, fragmentacja i half-close; realny procStart Linux = /proc starttime ticks. Wzorzec Pi starszej wersji używał ps lstart — discovery dostosowano.
- Native hold/refuse: własne profile z `--settings` wykazały rzeczywiste `held` i `expired` + `status_detail=refused`, bez uruchomienia modelu odbiorcy. Cleanup helpera/registry potwierdzony.
- Normalne native wysłanie nie daje potwierdzonego acceptance receipt w testowanym torze. Broker zapisuje `delivery_unknown`, a rzeczywistą odpowiedź weryfikuje się osobno. Nie zgaduje inReplyTo z ostatniego pytania.
- Codex 0.153.4: remote TUI i związany App Server, idle turn/start, **busy turn/steer PASS** z expectedTurnId zgodnym z tym samym aktywnym turnem; challenge odczytany, MCP reply wykonane i wróciło do Claude. Pierwotne ograniczone zadanie ukończone.
- Czyste Pi 0.85.1: extension bez globalnego role layer, idle triggerTurn, busy steer, reload i wieloturowość w tej samej sesji potwierdzone.

## Poza MVP

Antigravity, fizyczne rozproszenie i transparentne capture Claude↔Claude nie należą do LOCAL_3. Dwa logiczne hosty oraz wiele adapterów jednego hosta są sprawdzane lokalnymi testami WS/core, nie nazywane testem dwóch maszyn.
