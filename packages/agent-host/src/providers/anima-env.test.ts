import { describe, expect, test } from "bun:test";
import {
  animaSessionEnv,
  animaSessionEnvWithProcess,
  configureInstanceEnv,
  instanceSessionEnv,
} from "./anima-env";

describe("animaSessionEnv", () => {
  test("exports the session id the CLI auto-injects from", () => {
    configureInstanceEnv({});
    expect(animaSessionEnv("ses_abc")).toEqual({ ANIMA_SESSION_ID: "ses_abc" });
  });

  test("carries the configured instance variables", () => {
    configureInstanceEnv({ ANIMA_GATEWAY_URL: "ws://localhost:31086/ws" });
    try {
      expect(animaSessionEnv("ses_abc")).toEqual({
        ANIMA_GATEWAY_URL: "ws://localhost:31086/ws",
        ANIMA_SESSION_ID: "ses_abc",
      });
    } finally {
      configureInstanceEnv({});
    }
  });
});

describe("instanceSessionEnv", () => {
  test("is empty for a default instance", () => {
    expect(instanceSessionEnv({ gatewayPort: 30086, tmuxPrefix: "anima" }, {})).toEqual({});
  });

  test("points a second instance's sessions at its own gateway, config and panes", () => {
    const env = instanceSessionEnv(
      { gatewayPort: 31086, tmuxPrefix: "open-anima" },
      { ANIMA_HOME: "/x/home", ANIMA_DATA_DIR: "/x/data", PATH: "/bin" },
    );
    expect(env).toEqual({
      ANIMA_HOME: "/x/home",
      ANIMA_DATA_DIR: "/x/data",
      ANIMA_GATEWAY_URL: "ws://localhost:31086/ws",
      ANIMA_TMUX_PREFIX: "open-anima",
    });
  });

  test("forwards the watchdog variables so `anima watchdog …` reaches this instance's watchdog", () => {
    const env = instanceSessionEnv(
      { gatewayPort: 30086, tmuxPrefix: "anima" },
      {
        ANIMA_WATCHDOG_CONFIG: "/x/watchdog.json",
        ANIMA_WATCHDOG_PORT: "31085",
        ANIMA_WATCHDOG_LABEL: "com.anima.watchdog.second",
        ANIMA_SKIP_CLAUDE_UPDATE: "true",
        ANIMA_WATCHDOG_URL: "",
        HOME: "/Users/x",
      },
    );
    expect(env).toEqual({
      ANIMA_WATCHDOG_CONFIG: "/x/watchdog.json",
      ANIMA_WATCHDOG_PORT: "31085",
      ANIMA_WATCHDOG_LABEL: "com.anima.watchdog.second",
      ANIMA_SKIP_CLAUDE_UPDATE: "true",
    });
  });

  test("forwards an explicit tmux prefix, and the configured one wins", () => {
    expect(
      instanceSessionEnv(
        { gatewayPort: 30086, tmuxPrefix: "anima" },
        { ANIMA_TMUX_PREFIX: "anima" },
      ),
    ).toEqual({ ANIMA_TMUX_PREFIX: "anima" });
    expect(
      instanceSessionEnv(
        { gatewayPort: 30086, tmuxPrefix: "second" },
        { ANIMA_TMUX_PREFIX: "stale" },
      ),
    ).toEqual({ ANIMA_TMUX_PREFIX: "second" });
  });

  test("keeps an explicit gateway url", () => {
    const env = instanceSessionEnv(
      { gatewayPort: 31086, tmuxPrefix: "anima" },
      { ANIMA_GATEWAY_URL: "wss://anima.example.com/ws" },
    );
    expect(env.ANIMA_GATEWAY_URL).toBe("wss://anima.example.com/ws");
  });
});

describe("animaSessionEnvWithProcess", () => {
  test("carries process.env through for spawn APIs that replace it", () => {
    const env = animaSessionEnvWithProcess("ses_abc");
    expect(env.ANIMA_SESSION_ID).toBe("ses_abc");
    expect(env.PATH).toBe(process.env.PATH!);
  });

  test("applies overrides but never lets one clobber the session id", () => {
    const env = animaSessionEnvWithProcess("ses_abc", {
      CLAUDECODE: "",
      ANIMA_SESSION_ID: "stale",
    });
    expect(env.CLAUDECODE).toBe("");
    expect(env.ANIMA_SESSION_ID).toBe("ses_abc");
  });

  test("drops undefined process.env entries rather than passing them on", () => {
    const env = animaSessionEnvWithProcess("ses_abc");
    expect(Object.values(env).every((v) => typeof v === "string")).toBe(true);
  });
});
