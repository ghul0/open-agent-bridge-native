# Status implementacji NAB

Profil odbioru: **LOCAL_3**. Status projektu: **IN_PROGRESS**, nie DONE. Ustalenia SCOPE_LOCAL_3.md mają pierwszeństwo przed specyfikacją historyczną.

| Ticket | Stan | Kod / test / dowód |
|---|---|---|
| T00 | DONE_AUDIT | Prywatny preflight; środowisko rozpoznane, wersje w environment-report.md. |
| T01 | DONE_BASELINE | Fork ghul0/open-agent-bridge-native ma oczekiwany parent; SHA w upstream-lock.json. pnpm build/test/lint exit 0, 376 testów/48 plików. |
| T02 | IN_PROGRESS | Claude wire discovery/send/return PASS (nie model-model E2E); Codex i clean Pi live probes w toku. |
| T03 | IN_PROGRESS | architecture.md definiuje wspólny kontrakt; walidatory/testy core w toku. |
| T04–T06 | IN_PROGRESS | Registry/store/host boundary dla LOCAL_3; bez platformy auth. |
| T07–T09 | IN_PROGRESS | Reference MIT przypięta; helper native probe z realnym PID. |
| T10–T12 | IN_PROGRESS | Dwa narzędzia, controlled Codex, clean Pi. |
| T13 | OUT_OF_MVP | Antigravity pozostaje kierunkiem docelowym. |
| T14–T19 | NOT_RUN | Setup/doctor/E2E/busy/recovery wymagają integracji. |
| T20 | OUT_OF_MVP | Brak ingerencji w native Claude↔Claude; capture osobno. |
| T21 | IN_PROGRESS | Dwa logiczne hosty, routing/reconnect lokalnie; bez auth NAB i bez prawdziwego rozproszenia. |
| T22 | OUT_OF_MVP | Druga maszyna nie jest potrzebna do LOCAL_3. |
| T23–T24 | NOT_RUN | Wdrożenie dopiero po odpowiednich testach; niezależny review i publikacja we własnym forku. |

## Bramki LOCAL_3

Sześć inicjacji między różnymi harnessami, Codex↔Codex i Pi↔Pi, kontrola native Claude↔Claude; idle/busy, wieloturowość, dwie sesje w jednym cwd, restart/reconnect i niedostępny adresat. Każdy scenariusz ma nonce, tool trace, ID sesji i dowód odpowiedzi w poprawnym runtime. Żaden mock ani transportowy ACK nie zastępuje E2E.

## Prywatne dowody

Katalog stanu `$XDG_STATE_HOME/native-agent-broker` (fallback `~/.local/state/native-agent-broker`): `preflight-20260908`, `baseline`, `probes/native`, `probes/codex`, `probes/pi`. Surowe trace nie są commitowane. Wyniki niewykonane pozostają NOT_RUN, a nie PASS.
