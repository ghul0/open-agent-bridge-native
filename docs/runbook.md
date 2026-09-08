# Runbook instalacji LOCAL_3

Instalator nie jest jeszcze podpięty do `main` CLI i nie wykonuje automatycznie `systemctl`. Nie uruchamia też modeli. Poniższe API jest punktem integracji dla CLI po zakończeniu E2E.

## Przygotowanie release

`sourceDir` musi wskazywać katalog build zawierający co najmniej `dist/`, `node_modules/` i `dist/native/cli.js`. Instalator kopiuje wyłącznie produkcyjną allowlistę. Zachowuje wewnętrzne relatywne linki pnpm, a usuwa linki uszkodzone lub wychodzące poza release, dzięki czemu instalacja nie zależy od późniejszej obecności worktree. Extension czystego Pi jest wskazywane w prywatnym configu jako `dist/native/pi-nab-extension.js` wewnątrz release; przygotowanie profilu `~/.local/share/native-agent-broker/pi-clean` pozostaje osobnym krokiem.

```ts
import { installServices, setup } from "./native/install.js";

const installed = await setup({
  version: "<version>",
  sourceDir: "<absolute-release-directory>",
  nodePath: process.execPath,
  brokerUrl: "http://127.0.0.1:4998",
  hostId: "<stable-host-id>",
});
await installServices({ manifestPath: installed.manifestPath });
```

`setup` zapisuje release pod `~/.local/share/native-agent-broker/releases/<version>`, prywatny config (mode `0600`) i launcher `~/.local/bin/oab-native`. Config zawiera tylko `brokerUrl`, `hostId` i ścieżki. Nie zawiera tokenów ani RBAC. Istniejący katalog docelowy bez zgodnego manifestu nie jest nadpisywany.

## Uruchomienie i zatrzymanie

Po ręcznej kontroli unitów:

```sh
systemctl --user daemon-reload
systemctl --user enable --now nab-broker.service nab-host.service
systemctl --user status nab-broker.service nab-host.service
journalctl --user -u nab-broker.service -u nab-host.service
systemctl --user stop nab-host.service nab-broker.service
```

Broker binduje `127.0.0.1`; host łączy się wychodząco do skonfigurowanego URL. Unity mają ograniczony restart backoff. Instalator odrzuca nieloopbackowy URL w tym lokalnym profilu.

Status plików bez wywoływania systemd:

```ts
import { serviceStatus } from "./native/install.js";
console.log(await serviceStatus());
```

Nie odnotowano tu PASS wdrożenia ani E2E; ten runbook opisuje wyłącznie przygotowane helpery i ręczne kroki do wykonania przez integratora.
