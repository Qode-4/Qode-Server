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
                socketId: string;
            };

            try {
                const saved = await teamChatRepository.insertMessage({
                    chatId: data.roomId,
                    userId: data.userId,
                    content: data.content,
                });

                console.log("소켓ID:", data.socketId);
                console.log("저장된 메시지:", saved);
                io.to(data.roomId).except(data.socketId).emit("team:message:receive", saved);
                io.to(data.socketId).emit("team:message:sent", saved); // 발신자한테만 별도 이벤트
                // 분석 서비스로 넘기는 부분 (나중에 추가)
            } catch (err) {
                console.error("메시지 처리 실패:", err);
            }
        },
    });

    io.on("connection", (socket) => {
        console.log("소켓 연결됨:", socket.id);

        socket.on("room:join", (roomId: string) => {
            socket.join(roomId);
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
            try {
                await producer.send({
                    topic: TOPICS.TEAM_CHAT_MESSAGE,
                    messages: [{ value: JSON.stringify({...data, socketId: socket.id}) }],
                });
            } catch (err) {
                socket.emit("team:message:error", { message: "메시지 전송 실패" });
            }
        });

        socket.on("disconnect", () => {
            console.log("소켓 끊김:", socket.id);
        });
    });

    // 서버 종료 시 정리
    app.addHook("onClose", async () => {
        await producer.disconnect();
        await consumer.disconnect();
    });

    return io;
}