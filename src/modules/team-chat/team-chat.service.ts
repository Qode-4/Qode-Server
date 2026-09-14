import { HttpError } from "../../common/http-error.js";
import { resolveUniqueChatName } from "../chat/unique-name.js";
import { ProjectRepository } from "../project/project.repository.js";
import { TeamChatRepository } from "./team-chat.repository.js";

export class TeamChatService {
    constructor(
        private readonly repository: TeamChatRepository,
        private readonly projectRepository: ProjectRepository,
    ) {}

    async createRoom(params: {
        projectId: string;
        name: string;
        currentUserId: string;
    }) {
        const exists = await this.projectRepository.existsById(params.projectId);
        if (!exists) {
            throw new HttpError(404, "프로젝트를 찾을 수 없습니다. ");
        }

        const myRole = await this.projectRepository.findMemberRole(params.projectId, params.currentUserId);
        if (!myRole) {
            throw new HttpError(403, "프로젝트 멤버만 채팅방을 생성할 수 있습니다.");
        }

        return this.repository.createRoom({
            id: crypto.randomUUID(),
            projectId: params.projectId,
            name: params.name,
            createdBy: params.currentUserId,
        });
    }

    async getRoomOrThrow(chatId: string, currentUserId: string){
        const room = await this.repository.getRoom(chatId);

        if (!room) {
            throw new HttpError(404, "채팅방을 찾을 수 없습니다.");
        }

        const myRole = await this.projectRepository.findMemberRole(room.projectId, currentUserId);
        if (!myRole) {
            throw new HttpError(403, "접근 권한이 없습니다.");
        }

        return room;
    }

    // BR-D3-02 — 팀 채팅은 방 멤버 누구나 이름을 바꿀 수 있다.
    async renameRoomOrThrow(params: { chatId: string; name: string; currentUserId: string }) {
        const room = await this.repository.getRoom(params.chatId);
        if (!room) {
            throw new HttpError(404, "채팅방을 찾을 수 없습니다.");
        }

        const myRole = await this.projectRepository.findMemberRole(room.projectId, params.currentUserId);
        if (!myRole) {
            throw new HttpError(403, "프로젝트 멤버만 채팅방 이름을 변경할 수 있습니다.");
        }

        // BR-D3-04. 최종 이름을 사용자에게 돌려준다 — "(N)"이 붙었는지 화면이 알아야 한다.
        const taken = await this.repository.listRoomNames(room.projectId, params.chatId);
        const finalName = resolveUniqueChatName(params.name, taken);

        const updated = await this.repository.renameRoom(params.chatId, finalName);
        if (!updated) {
            throw new HttpError(404, "채팅방을 찾을 수 없습니다.");
        }
        return updated;
    }

    // BR-D1-04 — 하드 삭제다. 되돌릴 수 없어 방 OWNER 로 제한한다.
    async deleteRoomOrThrow(params: { chatId: string; currentUserId: string }) {
        const room = await this.repository.getRoom(params.chatId);
        if (!room) {
            throw new HttpError(404, "채팅방을 찾을 수 없습니다.");
        }

        // 프로젝트 역할이 아니라 방 역할이다. 프로젝트 OWNER 라도 남의 방은 못 지운다.
        const myRoomRole = await this.repository.getParticipantRole(params.chatId, params.currentUserId);
        if (myRoomRole !== "OWNER") {
            throw new HttpError(403, "채팅방을 만든 사람만 삭제할 수 있습니다.");
        }

        const deleted = await this.repository.deleteRoom(params.chatId);
        if (!deleted) {
            throw new HttpError(404, "채팅방을 찾을 수 없습니다.");
        }
    }

    async getRoomsByProject(projectId: string, currentUserId: string) {
        const exists = await this.projectRepository.existsById(projectId);
        if (!exists) {
            throw new HttpError(404, "프로젝트를 찾을 수 없습니다.");
        }
        
        const myRole = await this.projectRepository.findMemberRole(projectId, currentUserId);
        if (!myRole) {
            throw new HttpError(403, "접근 권한이 없습니다.");
        }

        return this.repository.getRoomsByProject(projectId);
    }

    async getMessages(params: {
        chatId: string;
        currentUserId: string;
        limit: number;
        before?: Date;
    }) {
        const room = await this.repository.getRoom(params.chatId);
        if (!room) {
            throw new HttpError(404, "채팅방을 찾을 수 없습니다.");
        }

        const myRole = await this.projectRepository.findMemberRole(room.projectId, params.currentUserId);
        if (!myRole) {
            throw new HttpError(403, "접근 권한이 없습니다.");
        }
        
        return this.repository.getMessage({
            chatId: params.chatId,
            limit: params.limit,
            before: params.before,
        });
    }

    async addParticipant(params: {
        chatId: string;
        userId: string;
        currentUserId: string;
    }) {
        const room = await this.repository.getRoom(params.chatId);
        if (!room) {
            throw new HttpError(404, "채팅방을 찾을 수 없습니다.");
        }

        const myRole = await this.projectRepository.findMemberRole(room.projectId, params.currentUserId);
        if (myRole !== "OWNER") {
            throw new HttpError(403, "채팅방 참여자 추가 권한이 없습니다.");
        }

        const targetRole = await this.projectRepository.findMemberRole(room.projectId, params.userId);
        if (!targetRole) {
            throw new HttpError(403, "프로젝트 멤버만 초대할 수 있습니다.");
        }

        return this.repository.addParticipant({
            chatId: params.chatId,
            userId: params.userId,
            role: "MEMBER",
        });
    }

    async getParticipants(chatId: string, currentUserId: string) {
        const room = await this.repository.getRoom(chatId);
        if (!room) {
            throw new HttpError(404, "채팅방을 찾을 수 없습니다.");
        }

        const myRole = await this.projectRepository.findMemberRole(room.projectId, currentUserId);
        if (!myRole) {
            throw new HttpError(403, "접근 권한이 없습니다.");
        }

        return this.repository.getParticipants(chatId);
    }
}