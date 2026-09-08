import assert from "node:assert/strict";
import { deliveryMode, LIST_AGENTS_SCHEMA, SEND_MESSAGE_SCHEMA } from "../../src/native/pi-nab-extension.js";

assert.deepEqual(SEND_MESSAGE_SCHEMA.required, ["to", "text"]);
assert.equal("message" in SEND_MESSAGE_SCHEMA.properties, false);
assert.equal("text" in SEND_MESSAGE_SCHEMA.properties, true);
assert.equal(LIST_AGENTS_SCHEMA.additionalProperties, false);
assert.equal(deliveryMode({ deliveryPolicy: "queue" }, true), "followUp");
assert.equal(deliveryMode({ deliveryPolicy: "queue" }, false), "steer");
assert.equal(deliveryMode({ deliveryPolicy: "steer" }, true), "steer");
assert.equal(deliveryMode({ deliveryPolicy: "auto" }, true), "steer");
process.stdout.write("pi extension unit: PASS\n");
