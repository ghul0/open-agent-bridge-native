import { expect, it } from "vitest";
import { codexProcessRole } from "./codex-processes.js";

it("counts native runtime separately from SSH proxy and Node launchers", () => {
  expect(codexProcessRole(["codex", "app-server", "--listen", "unix://"], "/bin/codex")).toBe("runtime");
  expect(codexProcessRole(["codex", "app-server", "proxy"], "/bin/codex")).toBe("proxy");
  expect(codexProcessRole(["node", "codex", "app-server", "--listen", "unix://"], "/bin/node")).toBeUndefined();
  expect(codexProcessRole(["codex", "app-server", "daemon", "version"], "/bin/codex")).toBeUndefined();
  expect(codexProcessRole(["codex", "resume", "thread"], "/bin/codex")).toBeUndefined();
});
