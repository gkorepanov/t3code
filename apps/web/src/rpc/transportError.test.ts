import { describe, expect, it } from "vitest";

import { isTransportConnectionErrorMessage, sanitizeThreadErrorMessage } from "./transportError";

describe("transportError", () => {
  it("detects websocket transport failures", () => {
    expect(isTransportConnectionErrorMessage("SocketCloseError: 1006")).toBe(true);
    expect(isTransportConnectionErrorMessage("Unable to connect to the T3 server WebSocket.")).toBe(
      true,
    );
    expect(isTransportConnectionErrorMessage("SocketOpenError: Timeout")).toBe(true);
    expect(
      isTransportConnectionErrorMessage("SocketReadError: An error occurred during Read"),
    ).toBe(true);
    expect(isTransportConnectionErrorMessage("SocketWriteError: write failed")).toBe(true);
    expect(isTransportConnectionErrorMessage("RpcClientDefect: Unknown socket error")).toBe(true);
  });

  it("preserves non-transport thread errors", () => {
    expect(sanitizeThreadErrorMessage("Turn failed")).toBe("Turn failed");
    expect(sanitizeThreadErrorMessage("Select a base branch before sending.")).toBe(
      "Select a base branch before sending.",
    );
  });

  it("drops transport failures from thread surfaces", () => {
    expect(sanitizeThreadErrorMessage("SocketCloseError: 1006")).toBeNull();
    expect(sanitizeThreadErrorMessage("SocketReadError: An error occurred during Read")).toBeNull();
    expect(sanitizeThreadErrorMessage("RpcClientDefect: Unknown socket error")).toBeNull();
  });
});
