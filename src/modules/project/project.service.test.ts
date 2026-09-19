import { describe, expect, it } from "vitest";
import { HttpError } from "../../common/http-error.js";
import { createProjectBodySchema } from "./project.schema.js";
import { MAX_TEAM_MEMBERS, ProjectService } from "./project.service.js";

type Member = { userId: string; role: "OWNER" | "MEMBER" };

const build = (opts: {
  code?: string;
  members?: Member[];
  memberCount?: number;
  takenNames?: string[];
  onMemberRemoved?: (projectId: string, userId: string) => Promise<void>;
}) => {
  const members = opts.members ?? [];
  const added: string[] = [];
  const created: string[] = [];
  const removed: string[] = [];
  let reissued = 0;

  const repository = {
    findProjectByInviteCode: async (code: string) =>
      opts.code && code === opts.code ? { id: "p1", name: "큐오드" } : null,
    findMemberRole: async (_p: string, userId: string) =>
      members.find((m) => m.userId === userId)?.role ?? null,
    countMembers: async () => opts.memberCount ?? members.length,
    addMember: async ({ user }: { user: { id: string } }) => {
      added.push(user.id);
      return {} as never;
    },
    removeMember: async (_p: string, userId: string) => {
      removed.push(userId);
      return true;
    },
    reissueInvite: async () => {
      reissued += 1;
      return "NEWCODE123";
    },
    existsById: async () => true,
    existsProjectNameForUser: async (_u: string, name: string) =>
      (opts.takenNames ?? []).some((t) => t.trim().toLowerCase() === name.trim().toLowerCase()),
    create: async (input: { name: string }) => {
      created.push(input.name);
      return {} as never;
    },
  };

  const authRepository = {
    findById: async (id: string) => ({ id, name: "홍길동", avatarUrl: null }),
  };

  const service = new ProjectService(
    repository as never,
    authRepository as never,
    opts.onMemberRemoved
  );
  return { service, added, removed, created, reissued: () => reissued };
};

const status = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return 0;
  } catch (error) {
    return error instanceof HttpError ? error.statusCode : -1;
  }
};

describe("초대 정보 조회", () => {
  it("없는 코드는 404", async () => {
    const { service } = build({ code: "GOOD" });
    expect(await status(() => service.getInviteInfo("BAD", "u1"))).toBe(404);
  });

  it("아직 멤버가 아니면 합류 시 받게 될 MEMBER를 돌려준다", async () => {
    const { service } = build({ code: "GOOD" });
    const info = await service.getInviteInfo("GOOD", "u1");
    expect(info.isAlreadyMember).toBe(false);
    expect(info.role).toBe("MEMBER");
  });

  it("이미 멤버면 실제 역할을 돌려준다", async () => {
    const { service } = build({ code: "GOOD", members: [{ userId: "u1", role: "OWNER" }] });
    const info = await service.getInviteInfo("GOOD", "u1");
    expect(info.isAlreadyMember).toBe(true);
    expect(info.role).toBe("OWNER");
  });
});

describe("초대 링크로 합류", () => {
  it("없는 코드는 404", async () => {
    const { service } = build({ code: "GOOD" });
    expect(await status(() => service.joinByInviteCode("BAD", "u1"))).toBe(404);
  });

  it("이미 멤버면 멤버를 새로 추가하지 않는다 (멱등)", async () => {
    const { service, added } = build({ code: "GOOD", members: [{ userId: "u1", role: "MEMBER" }] });
    const result = await service.joinByInviteCode("GOOD", "u1");
    expect(result.projectId).toBe("p1");
    expect(added).toHaveLength(0);
  });

  it(`${MAX_TEAM_MEMBERS - 1}명이면 들어갈 수 있다`, async () => {
    const { service, added } = build({ code: "GOOD", memberCount: MAX_TEAM_MEMBERS - 1 });
    await service.joinByInviteCode("GOOD", "u1");
    expect(added).toEqual(["u1"]);
  });

  it(`${MAX_TEAM_MEMBERS}명이면 409로 막는다`, async () => {
    const { service, added } = build({ code: "GOOD", memberCount: MAX_TEAM_MEMBERS });
    expect(await status(() => service.joinByInviteCode("GOOD", "u1"))).toBe(409);
    expect(added).toHaveLength(0);
  });

  it("팀이 꽉 차 있어도 기존 멤버는 자기 팀에 들어갈 수 있다", async () => {
    const { service } = build({
      code: "GOOD",
      members: [{ userId: "u1", role: "MEMBER" }],
      memberCount: MAX_TEAM_MEMBERS,
    });
    expect(await status(() => service.joinByInviteCode("GOOD", "u1"))).toBe(0);
  });
});

describe("멤버 제거·나가기", () => {
  const owner: Member = { userId: "owner", role: "OWNER" };
  const m1: Member = { userId: "m1", role: "MEMBER" };
  const m2: Member = { userId: "m2", role: "MEMBER" };

  it("OWNER는 다른 멤버를 내보낼 수 있다", async () => {
    const { service, removed } = build({ members: [owner, m1] });
    await service.removeMemberOrThrow("p1", "m1", "owner");
    expect(removed).toEqual(["m1"]);
  });

  it("강퇴 성공 후 onMemberRemoved 훅이 호출된다", async () => {
    const calls: Array<{ projectId: string; userId: string }> = [];
    const { service } = build({
      members: [owner, m1],
      onMemberRemoved: async (projectId, userId) => {
        calls.push({ projectId, userId });
      },
    });
    await service.removeMemberOrThrow("p1", "m1", "owner");
    expect(calls).toEqual([{ projectId: "p1", userId: "m1" }]);
  });

  it("훅이 실패해도 프로젝트 강퇴는 성공한다", async () => {
    const { service, removed } = build({
      members: [owner, m1],
      onMemberRemoved: async () => {
        throw new Error("team chat cleanup failed");
      },
    });
    // 예외가 밖으로 새어나가지 않는다
    await expect(service.removeMemberOrThrow("p1", "m1", "owner")).resolves.toBeUndefined();
    expect(removed).toEqual(["m1"]);
  });

  it("강퇴가 실패하면 훅은 호출되지 않는다", async () => {
    let called = false;
    const { service } = build({
      members: [owner, m1],
      onMemberRemoved: async () => {
        called = true;
      },
    });
    // OWNER 자기 자신 강퇴 시도 → 403 (repository.removeMember 이전에 던진다)
    await status(() => service.removeMemberOrThrow("p1", "owner", "owner"));
    expect(called).toBe(false);
  });

  it("일반 멤버는 남을 내보낼 수 없다 (403)", async () => {
    const { service, removed } = build({ members: [owner, m1, m2] });
    expect(await status(() => service.removeMemberOrThrow("p1", "m2", "m1"))).toBe(403);
    expect(removed).toHaveLength(0);
  });

  it("일반 멤버가 스스로 나가는 것은 된다", async () => {
    const { service, removed } = build({ members: [owner, m1] });
    await service.removeMemberOrThrow("p1", "m1", "m1");
    expect(removed).toEqual(["m1"]);
  });

  it("OWNER는 나가지도 제거되지도 않는다 (403) — 주인 없는 프로젝트 방지", async () => {
    const { service } = build({ members: [owner, m1] });
    expect(await status(() => service.removeMemberOrThrow("p1", "owner", "owner"))).toBe(403);
    expect(await status(() => service.removeMemberOrThrow("p1", "owner", "m1"))).toBe(403);
  });

  it("프로젝트 멤버가 아니면 404", async () => {
    const { service } = build({ members: [owner] });
    expect(await status(() => service.removeMemberOrThrow("p1", "owner", "남"))).toBe(404);
  });
});

describe("링크 재발급", () => {
  it("멤버면 누구나 새 링크를 만들 수 있다 (초대 권한과 같이 간다)", async () => {
    const { service, reissued } = build({ members: [{ userId: "m1", role: "MEMBER" }] });
    expect((await service.reissueInviteOrThrow("p1", "m1")).inviteCode).toBe("NEWCODE123");
    expect(reissued()).toBe(1);
  });

  it("멤버가 아니면 404", async () => {
    const { service } = build({ members: [] });
    expect(await status(() => service.reissueInviteOrThrow("p1", "남"))).toBe(404);
  });
});

// 명세 A-3 — 같은 이름 프로젝트가 여러 개면 목록에서 구분이 되지 않는다.
describe("프로젝트 이름 중복", () => {
  const creator = { id: "u1", name: "홍길동", avatarUrl: null };
  const create = (service: ReturnType<typeof build>["service"], name: string) =>
    service.create({ name } as never, creator);

  it("쓰지 않는 이름이면 만들어진다", async () => {
    const { service, created } = build({ takenNames: [] });

    await create(service, "큐오드");

    expect(created).toEqual(["큐오드"]);
  });

  it("같은 이름이 이미 있으면 409", async () => {
    const { service } = build({ takenNames: ["큐오드"] });

    expect(await status(() => create(service, "큐오드"))).toBe(409);
  });

  it("대소문자만 다르면 같은 이름으로 본다", async () => {
    const { service } = build({ takenNames: ["Qode"] });

    expect(await status(() => create(service, "qode"))).toBe(409);
  });

  it("앞뒤 공백만 다르면 같은 이름으로 본다", async () => {
    const { service } = build({ takenNames: ["큐오드"] });

    expect(await status(() => create(service, "  큐오드  "))).toBe(409);
  });

  it("막힐 때 프로젝트가 만들어지지 않는다", async () => {
    const { service, created } = build({ takenNames: ["큐오드"] });

    await status(() => create(service, "큐오드"));

    expect(created).toHaveLength(0);
  });
});

// 명세 A-3 — 화면(생성 모달)의 maxLength 와 같은 값이어야 한다.
describe("프로젝트 이름·설명 길이", () => {
  const parse = (name: string, description?: string) =>
    createProjectBodySchema.safeParse(description === undefined ? { name } : { name, description });

  it("이름 2~50자는 통과", () => {
    expect(parse("ab").success).toBe(true);
    expect(parse("가".repeat(50)).success).toBe(true);
  });

  it("이름 1자는 거부", () => {
    expect(parse("a").success).toBe(false);
  });

  it("이름 51자는 거부", () => {
    expect(parse("가".repeat(51)).success).toBe(false);
  });

  it("설명 200자는 통과, 201자는 거부", () => {
    expect(parse("프로젝트", "가".repeat(200)).success).toBe(true);
    expect(parse("프로젝트", "가".repeat(201)).success).toBe(false);
  });

  it("공백만 있는 이름은 trim 후 거부", () => {
    expect(parse("   ").success).toBe(false);
  });
});

