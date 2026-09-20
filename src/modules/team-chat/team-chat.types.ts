export type TeamChatRoom = {
  id: string;
  projectId: string;
  name: string;
  createdBy: string;
  createdAt: Date;
};

/**
 * 팀채팅 메시지.
 * digest 공유 카드는 role='ASSISTANT' + sources.length > 0 조합으로 판별한다.
 * deletedAt 은 클라이언트가 placeholder 렌더에 쓴다 — 서버는 필터하지 않고 그대로 보낸다.
 */
export type TeamChatMessage = {
  id: string;
  chatId: string;
  userId: string;
  userName: string;
  avatarUrl: string | null;
  role: "USER" | "ASSISTANT" | "SYSTEM";
  content: string;
  sources: unknown[];
  createdAt: Date;
  deletedAt: Date | null;
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