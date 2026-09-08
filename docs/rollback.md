# Rollback centralnej integracji

Manifesty release, konfiguracji MCP i migracji ownership są osobne. Cofaj je w odwrotnej kolejności, zatrzymując tylko własne usługi NAB, nie centralnego Codexa ani SSH proxy.

```bash
oab-native service stop
oab-native codex rollback-config --manifest "$HOME/.local/state/native-agent-broker/config-manifests/codex-mcp.json"
oab-native codex rollback-bindings --manifest OWNERSHIP_MANIFEST
oab-native rollback --manifest RELEASE_MANIFEST
systemctl --user daemon-reload
```

Ścieżki manifestów wypisują operacje konfiguracji, migracji i setup. Dokładne wartości lokalne są w runbooku w katalogu stanu. Po cofnięciu MCP wykonaj jego reload natywnym API lub kontrolowany restart centralnej usługi; nie przerywaj aktywnej pracy bez zgody.

- Release rollback porównuje hashe; przywraca własne backupy albo usuwa niezmienione dodatki. Późniejsze zmiany użytkownika zachowuje.
- MCP rollback odmawia nadpisania konfiguracji zmienionej po ostatnim setup. Trzeba wtedy odwrócić tylko własny blok po ręcznej kontroli; nie kopiować ślepo starego pełnego configu.
- Ownership rollback używa compare-and-set. Nie przejmuje endpointów, których owner został później zmieniony.
- Historia SQLite i OAuth nie są usuwane. Backup bazy wymaga pliku `.initialized`, nie samego pliku WAL.
- Powrót do starego release odtwarza stary model integracji; nie uruchamiaj go równocześnie z centralnym adapterem dla tych samych agentId.

`uninstall --keep-data --manifest RELEASE_MANIFEST` dotyczy wyłącznie własnej instalacji NAB. Nie usuwa centralnego codex-app-server.service, globalnego Codexa/Pi ani klienckich proxy SSH. Przed odinstalowaniem usuń zarządzany wpis MCP odpowiednią operacją rollback-config, żeby Codex nie próbował uruchamiać nieistniejącego pliku.
