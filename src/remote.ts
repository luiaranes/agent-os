import { execFile } from "node:child_process";

export type RemoteControlStatus = {
  available: boolean;
  detail: string;
};

export function checkRemoteControl(): Promise<RemoteControlStatus> {
  return new Promise((resolve) => {
    execFile("claude", ["remote-control", "--help"], { timeout: 20_000 }, (error, stdout, stderr) => {
      const text = `${stderr}\n${stdout}`.trim();
      const helpShown = /claude remote-control \[options\]/i.test(text);
      if (/disabled by your organization/i.test(text)) {
        resolve({
          available: false,
          detail:
            "Remote Control is disabled by your organization's policy. Sessions run on this laptop, and the Claude app cannot attach until an admin enables it.",
        });
        return;
      }
      if (error && !helpShown) {
        resolve({
          available: false,
          detail: text || error.message,
        });
        return;
      }
      resolve({
        available: true,
        detail:
          "Remote Control is on. A new session appears in the Claude app under the title you set, and messages from the phone show up here.",
      });
    });
  });
}
