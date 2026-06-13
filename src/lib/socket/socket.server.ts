import { Server } from "socket.io"
import type { FastifyInstance } from "fastify"
import { createChatRepository } from "../../modules/chat/chat.repository.js"
import { TeamChatRepository } from "../../modules/team-chat/team-chat.repository.js"

type ChatRepository = ReturnType<typeof createChatRepository>

export function initSocketServer(
    app: FastifyInstance, 
    chatRepository: ChatRepository | null,
    teamChatRepository: TeamChatRepository | null
) {
    if (!chatRepository) return

  const io = new Server(app.server, {
    cors: { origin: "*" }
  })

  io.on("connection", (socket) => {
    console.log("소켓 연결됨:", socket.id)

    socket.on("room:join", (roomId: string) => {
      socket.join(roomId)
    })

    socket.on("message:send", async (data: { roomId: string; content: string; userId: string }) => {
      // DB 저장
      const message = await chatRepository.insertMessage({
        chatId: data.roomId,
        userId: data.userId,
        role: "USER",
        content: data.content,
      })

      // 브로드캐스트
      io.to(data.roomId).emit("message:receive", message)
    })

    // 팀채팅
    socket.on("team:message:send", async (data: { roomId: string; content: string; userId: string }) => {
        if (!teamChatRepository) return

        try {
            const message = await teamChatRepository.insertMessage({
                chatId: data.roomId,
                userId: data.userId,
                content: data.content,
            })
            io.to(data.roomId).emit("team:message:receive", message)
        } catch (err) {
            socket.emit("team:message:error", { message: "메시지 전송 실패" })
        }
    })

    socket.on("disconnect", () => {
      console.log("소켓 끊김:", socket.id)
    })
  })

  return io
}