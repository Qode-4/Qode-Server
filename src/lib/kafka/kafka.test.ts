import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { Kafka } from "kafkajs";
import { Pool } from "pg";
import { initializeCoreSchema } from "../../modules/core-schema/core-schema.repository.js";
import { PgTeamChatRepository } from "../../modules/team-chat/team-chat.repository.js";
import { TOPICS } from "./kafka.client.js";

let pool: Pool;
let repo: PgTeamChatRepository;
let resolveMessage: ((data: unknown) => void) | null = null;

const kafka = new Kafka({
    clientId: "qode-test",
    brokers: ["localhost:9092"],
});

const producer = kafka.producer();
const consumer = kafka.consumer({ groupId: "test-group-2" }); // 그룹 ID 변경

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

    await producer.connect();
    await consumer.connect();
    await consumer.subscribe({ topic: TOPICS.TEAM_CHAT_MESSAGE, fromBeginning: false });

    // consumer.run을 한 번만 실행
    await consumer.run({
        eachMessage: async ({ message }) => {
            if (!message.value || !resolveMessage) return;
            const data = JSON.parse(message.value.toString());
            resolveMessage(data);
            resolveMessage = null;
        },
    });

    // rebalance 완료 대기
    await new Promise<void>((resolve) => setTimeout(resolve, 3000));
});

beforeEach(async () => {
    await pool.query(`
        TRUNCATE TABLE chat_participants, messages, chats, project_members, projects, users
        RESTART IDENTITY CASCADE
    `);
});

afterAll(async () => {
    await producer.disconnect();
    await consumer.disconnect();
    await pool.end();
});

describe("Kafka TeamChat", () => {
    it("메시지를 produce하고 consume할 수 있다", async () => {
        const userId = await pool.query(
            `INSERT INTO users (id, email, password, name) VALUES ($1, $2, 'hash', $3) RETURNING id`,
            [crypto.randomUUID(), "kafka@test.com", "TestUser"]
        ).then(r => r.rows[0].id);

        const projectId = await pool.query(
            `INSERT INTO projects (id, name, invite_code, created_by_id) VALUES ($1, 'Test', 'ABCD1234', $2) RETURNING id`,
            [crypto.randomUUID(), userId]
        ).then(r => r.rows[0].id);

        const room = await repo.createRoomWithParticipants({
            id: crypto.randomUUID(),
            projectId,
            name: "일반",
            createdBy: userId,
            memberIds: [],
        });

        const testData = {
            roomId: room.id,
            userId,
            content: "카프카 테스트 메시지",
        };

        const received = await new Promise<unknown>((resolve) => {
            resolveMessage = resolve;

            producer.send({
                topic: TOPICS.TEAM_CHAT_MESSAGE,
                messages: [{ value: JSON.stringify(testData) }],
            });
        });

        expect(received).toMatchObject({
            roomId: room.id,
            userId,
            content: "카프카 테스트 메시지",
        });
    }, 10000);
});