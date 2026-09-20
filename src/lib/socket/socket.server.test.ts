// socket.server.test.ts
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { io as ioc, type Socket } from "socket.io-client";
import type { AddressInfo } from "node:net";
import { Pool } from "pg";
import { initializeCoreSchema } from "../../modules/core-schema/core-schema.repository.js";
import { PgTeamChatRepository } from "../../modules/team-chat/team-chat.repository.js";

let pool: Pool;
let repo: PgTeamChatRepository;
let io: Server;
let httpServer: ReturnType<typeof createServer>;
let port: number;

beforeAll(async () => {
    pool = new Pool({
        host: "localhost",
        port: 5432,
        user: "postgres",
        password: "postgres",
        database: "test_db",
    });
    await initializeCoreSchema(pool);
    repo = new PgTeamChatRepository(pool);

    httpServer = createServer();
    io = new Server(httpServer, { cors: { origin: "*" } });

    io.on("connection", (socket) => {
        socket.on("room:join", (roomId: string) => {
            socket.join(roomId);
        });

        socket.on("team:message:send", async (data: {
            roomId: string;
            content: string;
            userId: string;
        }) => {
            try {
                const message = await repo.insertMessage({
                    chatId: data.roomId,
                    userId: data.userId,
                    content: data.content,
                });
                io.to(data.roomId).emit("team:message:receive", message);
            } catch (err) {
                socket.emit("team:message:error", { message: "메시지 전송 실패" });
            }
        });
    });

    await new Promise<void>((resolve) => {
        httpServer.listen(0, () => {
            port = (httpServer.address() as AddressInfo).port;
            resolve();
        });
    });
});

afterAll(async () => {
    io.close();
    httpServer.close();
    await pool.end();
});

beforeEach(async () => {
    await pool.query(`
        TRUNCATE TABLE chat_participants, messages, chats, project_members, projects, users
        RESTART IDENTITY CASCADE
    `);
});

const connectClient = (): Promise<Socket> => {
    return new Promise((resolve) => {
        const client = ioc(`http://localhost:${port}`);
        client.on("connect", () => resolve(client));
    });
};

const createTestUser = async (email: string) => {
    const id = crypto.randomUUID();
    await pool.query(
        `INSERT INTO users (id, email, password, name) VALUES ($1, $2, 'hash', $3)`,
        [id, email, "TestUser"]
    );
    return id;
};

const createTestProject = async (userId: string) => {
    const id = crypto.randomUUID();
    await pool.query(
        `INSERT INTO projects (id, name, invite_code, created_by_id) VALUES ($1, 'Test Project', 'ABCD1234', $2)`,
        [id, userId]
    );
    await pool.query(
        `INSERT INTO project_members (id, user_id, project_id, role) VALUES ($1, $2, $3, 'OWNER')`,
        [crypto.randomUUID(), userId, id]
    );
    return id;
};

describe("TeamChat Socket with DB", () => {
    describe("team:message:send", () => {
        it("메시지를 DB에 저장하고 같은 방 클라이언트에게 전달한다", async () => {
            const userId = await createTestUser("user@test.com");
            const projectId = await createTestProject(userId);
            const room = await repo.createRoomWithParticipants({
                id: crypto.randomUUID(),
                projectId,
                name: "일반",
                createdBy: userId,
                memberIds: [],
            });

            const clientA = await connectClient();
            const clientB = await connectClient();

            clientA.emit("room:join", room.id);
            clientB.emit("room:join", room.id);
            await new Promise<void>((resolve) => setTimeout(resolve, 100));

            const received = await new Promise((resolve) => {
                clientB.on("team:message:receive", (message) => {
                    resolve(message);
                });

                clientA.emit("team:message:send", {
                    roomId: room.id,
                    content: "안녕하세요",
                    userId,
                });
            });

            expect(received).toMatchObject({
                chatId: room.id,
                content: "안녕하세요",
                userId,
                userName: "TestUser",
            });

            // DB에도 저장됐는지 확인
            const messages = await repo.getMessage({ chatId: room.id, limit: 10 });
            expect(messages).toHaveLength(1);
            expect(messages[0]?.content).toBe("안녕하세요");

            clientA.disconnect();
            clientB.disconnect();
        });

        it("다른 방 클라이언트에게는 전달되지 않는다", async () => {
            const userId = await createTestUser("user@test.com");
            const projectId = await createTestProject(userId);
            const roomA = await repo.createRoomWithParticipants({ id: crypto.randomUUID(), projectId, name: "A", createdBy: userId, memberIds: [] });
            const roomB = await repo.createRoomWithParticipants({ id: crypto.randomUUID(), projectId, name: "B", createdBy: userId, memberIds: [] });

            const clientA = await connectClient();
            const clientB = await connectClient();

            clientA.emit("room:join", roomA.id);
            clientB.emit("room:join", roomB.id);
            await new Promise<void>((resolve) => setTimeout(resolve, 100));

            let received = false;
            clientB.on("team:message:receive", () => { received = true; });

            clientA.emit("team:message:send", {
                roomId: roomA.id,
                content: "안녕하세요",
                userId,
            });

            await new Promise<void>((resolve) => setTimeout(resolve, 200));
            expect(received).toBe(false);

            clientA.disconnect();
            clientB.disconnect();
        });
    });
});