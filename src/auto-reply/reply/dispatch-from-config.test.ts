import "./dispatch-from-config.base.test-utils.js";
import "./dispatch-from-config.routing.test-utils.js";
import "./dispatch-from-config.progress.test-utils.js";
import "./dispatch-from-config.abort-and-dedupe.test-utils.js";
import "./dispatch-from-config.lifecycle-and-bindings.test-utils.js";
import "./dispatch-from-config.delivery-and-tts.test-utils.js";
import "./dispatch-from-config.hooks-and-send-policy.test-utils.js";
import "./dispatch-from-config.send-policy-routing.test-utils.js";
import { beforeEach, describe, expect, it } from "vitest";
import {
  hookMocks,
  emptyConfig,
  createDispatcher,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  createHookCtx,
  describe1BeforeEach0,
  dispatchReplyFromConfig,
  firstMockArg,
} from "./dispatch-from-config.test-harness.js";

describe("before_dispatch inbound facts", () => {
  beforeEach(describe1BeforeEach0);

  it.each([
    { label: "human thread_broadcast", subtype: "thread_broadcast", isBot: false },
    { label: "bot file_share", subtype: "file_share", isBot: true },
  ])("projects $label into the actual event", async ({ subtype, isBot }) => {
    hookMocks.runner.runBeforeDispatch.mockResolvedValue({ handled: true });
    await dispatchReplyFromConfig({
      ctx: createHookCtx({ MessageSubtype: subtype, SenderIsBot: isBot }),
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
    });

    const event = firstMockArg(hookMocks.runner.runBeforeDispatch, "before dispatch hook") as
      | { messageSubtype?: string; senderIsBot?: boolean }
      | undefined;
    expect(event).toMatchObject({ messageSubtype: subtype, senderIsBot: isBot });
  });
});
