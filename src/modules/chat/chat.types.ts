import { RetrievedChunk, SourceInfo } from "../rag/rag.types.js";

export interface Messages {
  id: string; // PK
  chat_id: string; // FK 
  user_id: string | null; // FK (AI일 경우 null)
  content: string; 
  role: 'USER' | 'ASSISTANT' | 'SYSTEM';
  status: 'COMPLETE' | 'STREAMING' | 'FAILED';
  created_at: string;
}

export interface Chats {
  id: string; // PK
  project_id: string; // FK
  created_by: string; // FK
  name: string;
  chat_type: 'PERSONAL' | 'TEAM';
  created_at: string;
}

export interface ChatParticipants {
  chat_id: string; // PK
  user_id: string; // PK
  member_role: 'OWNER' | 'ADMIN' | 'MEMBER'; // default 'MEMBER'
  created_at: string;
  left_at: string | null; // TODO: 채팅 나가기 기능
}

export type StreamAssistantInput = {
  chatId: string;
  userId: string;
  content: string;
};

export type SaveContextSnapshotInput = {
  messageId: string;
  contextBlock: string;
  allChunks: RetrievedChunk[];
  citedChunks: RetrievedChunk[];
};

export type StreamAssistantOutput =
  | { type: "sources"; sources: SourceInfo[] }
  | {
      type: "context_snapshot";
      contextBlock: string;
      allChunks: RetrievedChunk[];
      citedChunks: RetrievedChunk[];
    };