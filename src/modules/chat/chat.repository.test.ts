import { describe, expect, it } from "vitest";
import { createChatRepository } from "./chat.repository.js";

const sources = [
  {
    filePath: "src/middleware/ssrSafe.ts",
    startLine: 1,
    endLine: 25,
    snippet: "SSR 상태 변경을 막습니다.",
    relevanceScore: 0.91,
  },
];

describe("assistant message sources", () => {
  it("stores streamed sources as JSON when finalizing", async () => {
    const query = async (sql: string, values: unknown[]) => {
      expect(sql).toContain("sources = $3::jsonb");
      expect(values).toEqual(["m1", "답변", JSON.stringify(sources)]);
      return { rowCount: 1, rows: [{ id: "m1" }] };
    };
    const repository = createChatRepository({ query } as never);

    await repository.finalizeMessage({ messageId: "m1", content: "답변", sources });
  });

  it("includes persisted sources when listing messages", async () => {
    const query = async (sql: string) => {
      expect(sql).toContain("status, sources, created_at");
      return { rowCount: 1, rows: [{ id: "m1", sources }] };
    };
    const repository = createChatRepository({ query } as never);

    await expect(repository.paginateMessages({ chatId: "c1" })).resolves.toEqual([{ id: "m1", sources }]);
  });
});
