import { Server } from "socket.io"
import type { FastifyInstance } from "fastify"
import { createChatRepository } from "../../modules/chat/chat.repository.js"
import { TeamChatRepository } from "../../modules/team-chat/team-chat.repository.js"
import { producer, consumer, TOPICS } from "../kafka/kafka.client.js";

type ChatRepository = ReturnType<typeof createChatRepository>

export async function initSocketServer(
    app: FastifyInstance,
    chatRepository: ChatRepository | null,
    teamChatRepository: TeamChatRepository | null
) {
    if (!chatRepository) return;

    const io = new Server(app.server, {
        cors: { origin: "*" }
    });

    // Kafka 연결에 실패해도 API 서버는 계속 뜬다. 팀 채팅만 일시 중단된다.
    // (재부팅 직후 Kafka가 아직 준비되지 않은 경우를 포함)
    let kafkaReady = false;

    try {
        // 프로듀서 연결
        await producer.connect();

        // 컨슈머 연결 및 구독
        await consumer.connect();
        await consumer.subscribe({ topic: TOPICS.TEAM_CHAT_MESSAGE, fromBeginning: false });

        // 컨슈머에서 DB 저장 + 브로드캐스트
        await consumer.run({
            eachMessage: async ({ message }) => {
                if (!teamChatRepository || !message.value) return;

                const data = JSON.parse(message.value.toString()) as {
                    roomId: string;
                    userId: string;
                    content: string;
                };

                try {
                    const saved = await teamChatRepository.insertMessage({
                        chatId: data.roomId,
                        userId: data.userId,
                        content: data.content,
                    });

                    io.to(data.roomId).emit("team:message:receive", saved);

                    // 분석 서비스로 넘기는 부분 (나중에 추가)
                } catch (err) {
                    console.error("메시지 처리 실패:", err);
                }
            },
        });

        kafkaReady = true;
    } catch (err) {
        app.log.warn({ err }, "Kafka 연결 실패 — 팀 채팅 일시 중단, API 서버는 계속 동작");
    }

    io.on("connection", (socket) => {
        console.log("소켓 연결됨:", socket.id);

        socket.on("room:join", (roomId: string) => {
            socket.join(roomId);
        });

        // 프로젝트 스코프 룸 — 팀채팅 생성·이름변경·삭제·초대·강퇴·양도 브로드캐스트를
        // 받으려면 활성 채팅에 join 하지 않은 사용자도 이 룸에 참여해야 한다.
        socket.on("project:join", (projectId: string) => {
            if (typeof projectId === "string" && projectId.length > 0) {
                socket.join(`project:${projectId}`);
            }
        });

        socket.on("project:leave", (projectId: string) => {
            if (typeof projectId === "string" && projectId.length > 0) {
                socket.leave(`project:${projectId}`);
            }
        });

        // 기존 AI 채팅
        socket.on("message:send", async (data: { roomId: string; content: string; userId: string }) => {
            const message = await chatRepository.insertMessage({
                chatId: data.roomId,
                userId: data.userId,
                role: "USER",
                content: data.content,
            });
            io.to(data.roomId).emit("message:receive", message);
        });

        // 팀채팅 - 카프카로 produce만
        socket.on("team:message:send", async (data: { roomId: string; content: string; userId: string }) => {
            if (!kafkaReady) {
                socket.emit("team:message:error", { message: "채팅 서버 연결 중입니다. 잠시 후 다시 시도해주세요." });
                return;
            }

            try {
                await producer.send({
                    topic: TOPICS.TEAM_CHAT_MESSAGE,
                    messages: [{ value: JSON.stringify(data) }],
                });
            } catch (err) {
                socket.emit("team:message:error", { message: "메시지 전송 실패" });
            }
        });

        socket.on("disconnect", () => {
            console.log("소켓 끊김:", socket.id);
        });
    });

    // 서버 종료 시 정리 (연결한 적이 없으면 끊을 것도 없다)
    app.addHook("onClose", async () => {
        if (!kafkaReady) return;
        await producer.disconnect();
        await consumer.disconnect();
    });

    return io;
}
