import { describe, expect, it } from "vitest";
import { renameChatBodySchema } from "./chat.schema.js";
import { CHAT_NAME_MAX_LENGTH, resolveUniqueChatName } from "./unique-name.js";

// 명세 BR-D3-04 — 예시는 "로그인 관련 질문" → "로그인 관련 질문 (2)" 다.
describe("채팅 이름 (N) 접미사", () => {
  it("겹치지 않으면 그대로 둔다", () => {
    expect(resolveUniqueChatName("로그인 관련 질문", ["다른 질문"])).toBe("로그인 관련 질문");
  });

  it("겹치면 (2) 를 붙인다", () => {
    expect(resolveUniqueChatName("로그인 관련 질문", ["로그인 관련 질문"])).toBe("로그인 관련 질문 (2)");
  });

  it("(2) 도 있으면 (3) 을 붙인다", () => {
    expect(
      resolveUniqueChatName("로그인 관련 질문", ["로그인 관련 질문", "로그인 관련 질문 (2)"])
    ).toBe("로그인 관련 질문 (3)");
  });

  it("중간이 비어 있으면 그 번호를 쓴다", () => {
    expect(
      resolveUniqueChatName("질문", ["질문", "질문 (3)"])
    ).toBe("질문 (2)");
  });

  it("앞뒤 공백은 비교 전에 없앤다", () => {
    expect(resolveUniqueChatName("  질문  ", ["질문"])).toBe("질문 (2)");
  });

  it("한도를 넘으면 앞을 잘라 접미사 자리를 만든다", () => {
    const long = "가".repeat(CHAT_NAME_MAX_LENGTH);

    const result = resolveUniqueChatName(long, [long]);

    expect(result.length).toBeLessThanOrEqual(CHAT_NAME_MAX_LENGTH);
    expect(result.endsWith(" (2)")).toBe(true);
  });

  it("겹치지 않아도 한도까지만 남긴다", () => {
    const long = "가".repeat(CHAT_NAME_MAX_LENGTH + 20);

    expect(resolveUniqueChatName(long, []).length).toBe(CHAT_NAME_MAX_LENGTH);
  });

  it("한도는 명세 값 100 이다", () => {
    expect(CHAT_NAME_MAX_LENGTH).toBe(100);
  });
});

// 명세 BR-D3-01 — 화면은 maxLength={100} 을 쓰고 errorMessages.ts 가 400 에
// "채팅 이름은 1~100자로 입력해주세요."를 걸어둔다. 서버가 더 좁으면 화면에서
// 쳐놓은 이름이 이유 없이 400 으로 튕긴다.
describe("채팅 이름 길이 스키마", () => {
  const parse = (name: string) => renameChatBodySchema.safeParse({ name });

  it("100자는 통과한다", () => {
    expect(parse("가".repeat(CHAT_NAME_MAX_LENGTH)).success).toBe(true);
  });

  it("101자는 거부한다", () => {
    expect(parse("가".repeat(CHAT_NAME_MAX_LENGTH + 1)).success).toBe(false);
  });

  it("공백만 있으면 trim 후 거부한다", () => {
    expect(parse("   ").success).toBe(false);
  });
});

