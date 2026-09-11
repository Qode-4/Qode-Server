export type TeamChatRoom = {
  id: string;
  projectId: string;
  name: string;
  createdBy: string;
  createdAt: Date;
};

export type TeamChatMessage = {
  id: string;
  chatId: string;
  userId: string;
  userName: string;
  avatarUrl: string | null;
  content: string;
  createdAt: Date;
};

export type TeamChatParticipant = {
  chatId: string;
  userId: string;
  memberRole: "OWNER" | "ADMIN" | "MEMBER";
  joinedAt: Date;
  userName: string;
  avatarUrl: string | null;
};

// 소켓 이벤트 타입
export type SocketSendMessagePayload = {
    chatId: string;
    content: string;
}

export type SocketReceiveMessagePayload = TeamChatMessage;

// TODO: 카프카 이벤트 타입