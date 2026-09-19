// 열린 과제 13-6. 파이썬이 200 으로 status=failed 를 돌려주던 시절의 구멍을 막는다
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnalysisServerClient } from "./analysis-server-client.js";

const client = new AnalysisServerClient({ baseUrl: "http://analysis", internalToken: "t" });
const input = { projectId: "p1", syncJobId: "j1" };
const mockFetch = (status: number, body: unknown) =>
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));

afterEach(() => vi.unstubAllGlobals());

describe("startIndexJob", () => {
  it("완료 응답이면 청크 수를 돌려준다", async () => {
    mockFetch(200, { status: "completed", chunks_created: 42 });
    await expect(client.startIndexJob(input)).resolves.toEqual({ status: "completed", chunksCreated: 42 });
  });

  it("200 이라도 본문이 failed 면 던진다", async () => {
    mockFetch(200, { status: "failed", chunks_created: 0, error: "repo missing" });
    await expect(client.startIndexJob(input)).rejects.toThrow(/repo missing/);
  });

  it("500 이면 던진다", async () => {
    mockFetch(500, { detail: { status: "failed", error: "boom" } });
    await expect(client.startIndexJob(input)).rejects.toThrow(/500/);
  });
});
