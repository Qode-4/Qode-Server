import Fastify from "fastify";
import jwt from "jsonwebtoken";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerErrorHandler } from "../../common/error-handler.js";
import { registerTeamChatRoutes } from "./team-chat.route.js";
import { TeamChatService } from "./team-chat.service.js";

const chatId = "00000000-0000-4000-8000-000000000001";
const meId = "00000000-0000-4000-8000-000000000002";
const otherId = "00000000-0000-4000-8000-000000000003";

const authRepository = {
    findById: async (id: string) => ({
        id,
        email: "me@test.com",
        passwordHash: "unused",
        name: "Me",
        avatarUrl: null,
        tokenVersion: 0,
    }),
} as never;

const bearer = `Bearer ${jwt.sign({ sub: meId, tokenVersion: 0 }, "test-secret")}`;

const buildApp = (service: TeamChatService, ioEmit?: (event: string, payload: unknown) => void) => {
    const app = Fastify();
    registerErrorHandler(app);
    const io = ioEmit
        ? ({
              to: () => ({ emit: ioEmit }),
          } as unknown as import("socket.io").Server)
        : null;
    return { app, register: () => registerTeamChatRoutes(app, {
        repository: {} as never,
        projectRepository: {} as never,
        authRepository,
        service,
        io,
    }) };
};

describe("team-chat routes", () => {
    const apps: Array<ReturnType<typeof Fastify>> = [];
    afterEach(async () => {
        await Promise.all(apps.splice(0).map((app) => app.close()));
    });

    describe("DELETE /api/chats/:chatId/participants/:userId — kick", () => {
        it("성공 시 204 반환하고 소켓 이벤트를 emit 한다", async () => {
            const kick = vi.fn().mockResolvedValue({ chatDeleted: false });
            const service = { kickParticipant: kick } as unknown as TeamChatService;
            const emitted: Array<{ event: string; payload: unknown }> = [];
            const { app, register } = buildApp(service, (event, payload) => {
                emitted.push({ event, payload });
            });
            apps.push(app);
            await register();

            const res = await app.inject({
                method: "DELETE",
                url: `/api/chats/${chatId}/participants/${otherId}`,
                headers: { authorization: bearer },
            });

            expect(res.statusCode).toBe(204);
            expect(kick).toHaveBeenCalledWith({ chatId, targetUserId: otherId, currentUserId: meId });
            expect(emitted.map((e) => e.event)).toContain("team:participants:changed");
        });

        it("자기 자신 강퇴 시 서비스가 400 던지면 400", async () => {
            const kick = vi.fn().mockImplementation(async () => {
                const { HttpError } = await import("../../common/http-error.js");
                throw new HttpError(400, "자기 자신은 강퇴할 수 없습니다.");
            });
            const service = { kickParticipant: kick } as unknown as TeamChatService;
            const { app, register } = buildApp(service);
            apps.push(app);
            await register();

            const res = await app.inject({
                method: "DELETE",
                url: `/api/chats/${chatId}/participants/${meId}`,
                headers: { authorization: bearer },
            });

            expect(res.statusCode).toBe(400);
        });

        it("강퇴 후 마지막 참여자가 나가면 team:room:deleted 도 emit", async () => {
            const kick = vi.fn().mockResolvedValue({ chatDeleted: true });
            const service = { kickParticipant: kick } as unknown as TeamChatService;
            const emitted: Array<{ event: string; payload: unknown }> = [];
            const { app, register } = buildApp(service, (event, payload) => {
                emitted.push({ event, payload });
            });
            apps.push(app);
            await register();

            await app.inject({
                method: "DELETE",
                url: `/api/chats/${chatId}/participants/${otherId}`,
                headers: { authorization: bearer },
            });

            expect(emitted.map((e) => e.event)).toContain("team:room:deleted");
        });
    });

    describe("POST /api/chats/:chatId/transfer-ownership", () => {
        it("성공 시 204 반환하고 team:ownership:transferred 이벤트 emit", async () => {
            const transferOwnership = vi.fn().mockResolvedValue({
                previousOwnerId: meId,
                newOwnerId: otherId,
            });
            const service = { transferOwnership } as unknown as TeamChatService;
            const emitted: Array<{ event: string; payload: unknown }> = [];
            const { app, register } = buildApp(service, (event, payload) => {
                emitted.push({ event, payload });
            });
            apps.push(app);
            await register();

            const res = await app.inject({
                method: "POST",
                url: `/api/chats/${chatId}/transfer-ownership`,
                headers: { authorization: bearer },
                payload: { newOwnerId: otherId },
            });

            expect(res.statusCode).toBe(204);
            expect(transferOwnership).toHaveBeenCalledWith({
                chatId,
                newOwnerId: otherId,
                currentUserId: meId,
            });
            const evt = emitted.find((e) => e.event === "team:ownership:transferred");
            expect(evt?.payload).toEqual({ chatId, newOwnerId: otherId, previousOwnerId: meId });
        });

        it("newOwnerId 가 uuid 가 아니면 400", async () => {
            const service = { transferOwnership: vi.fn() } as unknown as TeamChatService;
            const { app, register } = buildApp(service);
            apps.push(app);
            await register();

            const res = await app.inject({
                method: "POST",
                url: `/api/chats/${chatId}/transfer-ownership`,
                headers: { authorization: bearer },
                payload: { newOwnerId: "not-uuid" },
            });

            expect(res.statusCode).toBe(400);
        });
    });

    describe("DELETE /api/chats/:chatId/participants/me — leave", () => {
        it("chatDeleted:true 를 응답에 담아 준다", async () => {
            const leaveRoomOrThrow = vi.fn().mockResolvedValue({ deleted: true });
            const service = { leaveRoomOrThrow } as unknown as TeamChatService;
            const emitted: Array<{ event: string; payload: unknown }> = [];
            const { app, register } = buildApp(service, (event, payload) => {
                emitted.push({ event, payload });
            });
            apps.push(app);
            await register();

            const res = await app.inject({
                method: "DELETE",
                url: `/api/chats/${chatId}/participants/me`,
                headers: { authorization: bearer },
            });

            expect(res.statusCode).toBe(200);
            expect(res.json()).toEqual({ ok: true, data: { chatDeleted: true } });
            expect(emitted.map((e) => e.event)).toContain("team:room:deleted");
        });
    });
});
