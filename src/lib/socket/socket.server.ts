import { Server } from "socket.io"
import type { FastifyInstance } from "fastify"
import { createChatRepository } from "../../modules/chat/chat.repository.js"

type ChatRepository = ReturnType<typeof createChatRepository>

export function initSocketServer(
    app: FastifyInstance, 
    chatRepository: ChatRepository | null
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

    socket.on("disconnect", () => {
      console.log("소켓 끊김:", socket.id)
    })
  })

  return io
}