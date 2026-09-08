# Rollback instalacji lokalnej

Rollback korzysta z manifestu utworzonego przez `setup`. Usuwa wyłącznie ścieżki, które przed instalacją nie istniały i których aktualny hash nadal zgadza się z hashem zapisanym po instalacji. Zmienione później pliki oraz zastane pliki są zachowywane i raportowane w `preserved`.

Przed rollbackiem zatrzymaj unity użytkownika (jeśli zostały uruchomione):

```sh
systemctl --user stop nab-host.service nab-broker.service
```

Wywołanie z TypeScript:

```ts
import { rollback } from "./native/install.js";
const result = await rollback(manifestPath);
console.log(result.removed, result.preserved);
```

Po usunięciu unitów przeładuj managera:

```sh
systemctl --user daemon-reload
```

Manifest pozostaje jako dowód operacji. Rollback nie usuwa katalogów nadrzędnych ani danych stanu brokera, jeśli nie były wpisem należącym do instalatora. Jeśli plik został zmieniony, należy ocenić go ręcznie; instalator celowo nie wymusza usunięcia.
